import os
import json
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from rocket_reader import RocketReader

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

rocket_host = os.getenv("ROCKET_HOST", "192.168.1.20")
rocket_user = os.getenv("ROCKET_USER", "wfr-daq")
rocket_pass = os.getenv("ROCKET_PASS", "westernformularacing")

reader = RocketReader(host=rocket_host, user=rocket_user, password=rocket_pass)

APP_DIR = Path(__file__).parent


@app.get("/signal")
def get_signal():
    data = reader.get_status()
    if not data:
        return {"error": "no data"}

    direction = reader.compute_direction(data["chain0"], data["chain1"])
    normalized = reader.normalize(direction["error"])

    return {
        "chain0": data["chain0"],
        "chain1": data["chain1"],
        "error": direction["error"],
        "normalized": normalized,
        "strength": direction["strength"],
    }


@app.get("/")
def index():
    return FileResponse(str(APP_DIR / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8060)
