import os
import csv
import math
import random
from datetime import datetime, timedelta

OUTPUT_DIR = "./generated-days"
DAYS = 5
SESSIONS_PER_DAY = 3
SESSION_LENGTH_MIN = 15              # minutes (increased for better data duration)
FREQ_HZ = 50                         # Base frequency
START_DATE = datetime(2025, 1, 1)
PROTOCOL = "CAN"

# CSV layout expected by startup-data-loader/load_data.py
CSV_HEADER = ["relative_ms", "protocol", "can_id"] + [f"byte{i}" for i in range(8)]

# CAN IDs from installer/example.dbc
ID_VCU_STATUS = 192
ID_PEDAL_SENSORS = 193
ID_STEERING_WHEEL = 194
ID_BMS_STATUS = 512
ID_BMS_CELL_STATS = 513
ID_MC_COMMAND = 256
ID_MC_FEEDBACK = 257
ID_WHEEL_SPEEDS = 768
ID_IMU_DATA = 1024
ID_COOLING_STATUS = 1280

os.makedirs(OUTPUT_DIR, exist_ok=True)

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

def encode_unsigned(value, scale, offset, bits):
    raw = int((value - offset) / scale)
    return raw & ((1 << bits) - 1)

def encode_signed(value, scale, offset, bits):
    raw = int((value - offset) / scale)
    if raw < 0:
        raw = (1 << bits) + raw
    return raw & ((1 << bits) - 1)

def to_le_bytes(value, length):
    """Return little-endian byte list of the provided raw value."""
    return list(value.to_bytes(length, byteorder="little"))

class VehicleSimulation:
    def __init__(self):
        self.time = 0.0
        self.speed = 0.0  # m/s
        self.soc = 95.0   # %
        self.battery_temp = 30.0 # C
        self.motor_temp = 40.0 # C
        self.coolant_temp = 35.0 # C
        self.odometer = 0.0
        self.lap_timer = 0.0
        
        # Internal state for smooth random walks
        self.steer_target = 0.0
        self.throttle_target = 0.0
        self.brake_target = 0.0
        
    def step(self, dt):
        self.time += dt
        self.lap_timer += dt
        
        # Generate driver inputs (random walk)
        if random.random() < 0.05:
            self.steer_target = random.gauss(0, 60) # degrees
        
        # Accelerate/Brake cycle logic
        cycle_time = self.time % 40 # 40 second cycle
        if cycle_time < 15: # Accelerate
            self.throttle_target = 80 + random.gauss(0, 10)
            self.brake_target = 0
        elif cycle_time < 20: # Coast
            self.throttle_target = 0
            self.brake_target = 0
        elif cycle_time < 30: # Brake
            self.throttle_target = 0
            self.brake_target = 60 + random.gauss(0, 10)
        else: # Low speed / Turn
            self.throttle_target = 20
            self.brake_target = 0
            
        # Smooth inputs
        self.throttle_curr = self.throttle_target # Simplified
        self.brake_curr = self.brake_target # Simplified
        self.steer_curr = self.steer_target # Simplified
        
        # Physics (Very basic)
        accel = 0.0
        if self.throttle_curr > 5:
            accel = (self.throttle_curr / 100.0) * 10.0 # Max 10 m/s^2
        if self.brake_curr > 5:
            accel -= (self.brake_curr / 100.0) * 15.0 # Max brake
            
        # Drag
        drag = 0.01 * self.speed * self.speed
        accel -= drag
        
        self.speed += accel * dt
        self.speed = max(0, self.speed)
        
        # Energy
        power = self.speed * accel * 200 # mass 200kg approx + constants
        current = power / 400.0 # 400V nominal
        
        # Heat
        self.battery_temp += abs(current) * 0.0001 * dt - (self.battery_temp - 25) * 0.001 * dt
        self.motor_temp += abs(power) * 0.00005 * dt - (self.motor_temp - 30) * 0.002 * dt
        self.coolant_temp = (self.motor_temp + self.battery_temp) / 2.0 - 5.0
        
        self.soc -= abs(current) * 0.00005 * dt
        self.current = current
        self.accel_lat = (self.speed ** 2) * math.sin(math.radians(self.steer_curr)) * 0.1 # Fake cornering

    def get_vcu_status(self):
        state = 4 if self.speed > 0.1 else 1 # Drive vs Ready
        safety = 1
        inv_en = 1
        
        data = [0] * 8
        data[0] = (state & 0x0F) | ((safety & 1) << 4) | ((inv_en & 1) << 5)
        return [ID_VCU_STATUS] + data

    def get_pedal_sensors(self):
        apps = clamp(self.throttle_curr, 0, 100)
        brake_f = clamp(self.brake_curr * 1.5, 0, 200) # bar
        brake_r = clamp(self.brake_curr * 1.0, 0, 200) # bar
        
        apps_raw = encode_unsigned(apps, 0.1, 0, 16)
        bf_raw = encode_unsigned(brake_f, 0.1, 0, 16)
        br_raw = encode_unsigned(brake_r, 0.1, 0, 16)
        
        data = (
            to_le_bytes(apps_raw, 2) + 
            to_le_bytes(apps_raw, 2) + # APPS2 same as 1
            to_le_bytes(bf_raw, 2) +
            to_le_bytes(br_raw, 2)
        )
        return [ID_PEDAL_SENSORS] + data

    def get_steering(self):
        angle = clamp(self.steer_curr, -180, 180)
        angle_raw = encode_signed(angle, 0.1, 0, 16)
        
        drs = 1 if self.speed > 20 and self.throttle_curr > 90 else 0
        launch = 0
        
        data = to_le_bytes(angle_raw, 2) + [drs, launch, 0, 0, 0, 0]
        return [ID_STEERING_WHEEL] + data

    def get_bms_status(self):
        volt = 400.0 + (self.soc - 50) * 0.5 - (self.current * 0.05)
        curr = self.current
        
        v_raw = encode_unsigned(volt, 0.1, 0, 16)
        i_raw = encode_signed(curr, 0.1, 0, 16)
        soc_raw = encode_unsigned(self.soc, 0.5, 0, 8)
        
        data = to_le_bytes(v_raw, 2) + to_le_bytes(i_raw, 2) + [soc_raw, 0, 0, 0]
        return [ID_BMS_STATUS] + data

    def get_bms_cells(self):
        avg_cell = (400.0 + (self.soc - 50) * 0.5) / 100.0 # 100s assumed
        min_cell = avg_cell - 0.02
        max_cell = avg_cell + 0.02
        
        min_raw = encode_unsigned(min_cell, 0.001, 0, 16)
        max_raw = encode_unsigned(max_cell, 0.001, 0, 16)
        avg_raw = encode_unsigned(avg_cell, 0.001, 0, 16)
        temp_raw = encode_unsigned(self.battery_temp, 1, -40, 8)
        
        data = to_le_bytes(max_raw, 2) + to_le_bytes(min_raw, 2) + to_le_bytes(avg_raw, 2) + [temp_raw, 0]
        return [ID_BMS_CELL_STATS] + data

    def get_mc_command(self):
        torque_req = self.throttle_curr * 2.0 # approx 200Nm max
        if self.brake_curr > 0:
            torque_req = -self.brake_curr # Regen
            
        trq_raw = encode_signed(torque_req, 0.1, 0, 16)
        spd_raw = encode_unsigned(6000, 1, 0, 16) # Limit
        
        data = to_le_bytes(trq_raw, 2) + to_le_bytes(spd_raw, 2) + [0, 0, 0, 0]
        return [ID_MC_COMMAND] + data

    def get_mc_feedback(self):
        rpm = self.speed * 60.0 * 3.0 # approx gear ratio / wheel size factor
        torque = self.throttle_curr * 2.0
        
        rpm_raw = encode_signed(rpm, 1, 0, 16)
        trq_raw = encode_signed(torque, 0.1, 0, 16)
        dc_i_raw = encode_signed(self.current, 0.1, 0, 16)
        temp_raw = encode_unsigned(self.motor_temp, 1, -40, 8)
        
        data = to_le_bytes(rpm_raw, 2) + to_le_bytes(trq_raw, 2) + to_le_bytes(dc_i_raw, 2) + [temp_raw, 0]
        return [ID_MC_FEEDBACK] + data
        
    def get_wheel_speeds(self):
        rpm = self.speed * 60.0 / (0.4 * 3.14159) # 0.4m dia tire approx
        
        # Add slight slip/noise
        fl = rpm * (1.0 + random.gauss(0, 0.01))
        fr = rpm * (1.0 + random.gauss(0, 0.01))
        rl = rpm * (1.0 + random.gauss(0, 0.02))
        rr = rpm * (1.0 + random.gauss(0, 0.02))
        
        data = (
            to_le_bytes(encode_unsigned(fl, 1, 0, 16), 2) +
            to_le_bytes(encode_unsigned(fr, 1, 0, 16), 2) +
            to_le_bytes(encode_unsigned(rl, 1, 0, 16), 2) +
            to_le_bytes(encode_unsigned(rr, 1, 0, 16), 2)
        )
        return [ID_WHEEL_SPEEDS] + data

    def get_imu(self):
        ax = (self.throttle_curr - self.brake_curr) / 100.0 * 1.5 # g approx
        ay = self.accel_lat / 9.81
        az = 1.0
        yaw = self.speed * math.tan(math.radians(self.steer_curr)) / 1.53 # wheelbase
        
        data = (
            to_le_bytes(encode_signed(ax, 0.001, 0, 16), 2) +
            to_le_bytes(encode_signed(ay, 0.001, 0, 16), 2) +
            to_le_bytes(encode_signed(az, 0.001, 0, 16), 2) +
            to_le_bytes(encode_signed(yaw, 0.1, 0, 16), 2)
        )
        return [ID_IMU_DATA] + data

    def get_cooling(self):
        pump = 100 if self.motor_temp > 50 else 50
        fan = 100 if self.coolant_temp > 60 else 0
        
        data = [
            encode_unsigned(self.coolant_temp - 5, 1, -40, 8), # In
            encode_unsigned(self.coolant_temp, 1, -40, 8),     # Out
            encode_unsigned(pump, 1, 0, 8),
            encode_unsigned(fan, 1, 0, 8),
            0, 0, 0, 0
        ]
        return [ID_COOLING_STATUS] + data


def generate_session_csv(session_start, output_dir):
    session_name = session_start.strftime("%Y-%m-%d-%H-%M-%S")
    fname = os.path.join(output_dir, f"{session_name}.csv")

    duration_ms = SESSION_LENGTH_MIN * 60 * 1000
    dt = 1.0 / FREQ_HZ
    interval_ms = int(1000 / FREQ_HZ)
    
    sim = VehicleSimulation()

    with open(fname, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(CSV_HEADER)

        rel_ms = 0
        while rel_ms <= duration_ms:
            sim.step(dt)
            
            # Interleave messages. 
            # For simplicity, we write all messages at the same timestamp block, 
            # or we could round-robin. 
            # Writing all provides dense data which is good for demos.
            
            msgs = [
                sim.get_vcu_status(),
                sim.get_pedal_sensors(),
                sim.get_steering(),
                sim.get_bms_status(),
                sim.get_bms_cells(),
                sim.get_mc_command(),
                sim.get_mc_feedback(),
                sim.get_wheel_speeds(),
                sim.get_imu(),
                sim.get_cooling()
            ]
            
            for msg_data in msgs:
                # msg_data is [ID, b0, b1...]
                # row: [rel_ms, protocol, id, b0...b7]
                row = [rel_ms, PROTOCOL, msg_data[0]] + msg_data[1:]
                writer.writerow(row)

            rel_ms += interval_ms

    print(f"Generated: {fname}")


def main():
    print(f"Generating data for {DAYS} days...")
    for day in range(DAYS):
        day_date = START_DATE + timedelta(days=day)

        for session in range(SESSIONS_PER_DAY):
            minutes_offset = session * (SESSION_LENGTH_MIN + 30) + random.randint(5, 15)
            session_start = day_date + timedelta(minutes=minutes_offset)
            generate_session_csv(session_start, OUTPUT_DIR)

    print("Done!")


if __name__ == "__main__":
    main()