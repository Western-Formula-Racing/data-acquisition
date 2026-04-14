
import os
import slicks
from slicks.discovery import discover_sensors
from datetime import datetime, timedelta

host = os.getenv("INFLUX_HOST", "http://influxdb3:8181")
token = os.getenv("INFLUX_TOKEN", "")
db = os.getenv("INFLUX_DATABASE", "WFR25")

print(f"Connecting to {host}, db={db}")
slicks.connect_influxdb3(url=host, token=token, db=db)

# Naive UTC datetime (no tzinfo)
end = datetime.utcnow()
start = end - timedelta(days=365)

print(f"Scanning range (naive): {start} to {end}")

try:
    sensors = discover_sensors(
        start_time=start,
        end_time=end,
        chunk_size_days=7,
        show_progress=False,
    )
    print(f"Found {len(sensors)} sensors.")
    # print(sensors)
except Exception as e:
    print(f"Error: {e}")
