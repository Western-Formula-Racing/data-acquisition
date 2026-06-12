import os
import subprocess


def get_git_hash() -> str:
    """Return a short git hash for the running code.

    Resolution order:
    1. GIT_HASH env var — set at Docker build time via ARG/ENV, or in the
       systemd unit. Fastest path and works when .git is absent.
    2. Live `git rev-parse --short HEAD` — works for native/dev installs.
    3. 'unknown' — Docker image built without GIT_HASH and no .git available.
    """
    h = os.getenv("GIT_HASH", "").strip()
    if h:
        return h[:7]
    try:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=3, cwd=root,
        )
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:
        pass
    return "unknown"
