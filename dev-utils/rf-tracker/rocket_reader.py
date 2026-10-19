import paramiko
import re
import os


class RocketReader:
    def __init__(self, host=None, user=None, password=None):
        self.host = host or os.getenv("ROCKET_HOST", "192.168.1.20")
        self.user = user or os.getenv("ROCKET_USER", "wfr-daq")
        self.password = password or os.getenv("ROCKET_PASS", "westernformularacing")

    def get_status(self):
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(self.host, username=self.user, password=self.password)

        stdin, stdout, stderr = ssh.exec_command("mca-status")
        output = stdout.read().decode()
        ssh.close()

        return self.parse(output)

    def parse(self, raw):
        match = re.search(r'"chain":\s*\[(-?\d+),\s*(-?\d+)\]', raw)
        if not match:
            return None

        c0 = int(match.group(1))
        c1 = int(match.group(2))

        return {
            "chain0": c0,
            "chain1": c1,
        }

    def compute_direction(self, c0, c1):
        error = c0 - c1
        strength = (c0 + c1) / 2
        return {
            "error": error,
            "strength": strength,
        }

    def normalize(self, error):
        return max(min(error / 20.0, 1), -1)


if __name__ == "__main__":
    reader = RocketReader()
    data = reader.get_status()
    if data:
        direction = reader.compute_direction(data["chain0"], data["chain1"])
        print(f"chain0={data['chain0']}, chain1={data['chain1']}, "
              f"error={direction['error']}, normalized={reader.normalize(direction['error']):.2f}, "
              f"strength={direction['strength']:.1f}")
    else:
        print("Failed to parse mca-status output")
