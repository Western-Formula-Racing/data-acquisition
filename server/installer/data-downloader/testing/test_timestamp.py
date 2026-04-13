
import os
from datetime import datetime, timezone
from influxdb_client_3 import InfluxDBClient3

host = os.getenv("INFLUX_HOST", "http://influxdb3:8181")
token = os.getenv("INFLUX_TOKEN", "")
db = os.getenv("INFLUX_DATABASE", "WFR25")

client = InfluxDBClient3(host=host, token=token, database=db)

# Create a UTC datetime
t0 = datetime(2025, 10, 4, tzinfo=timezone.utc)
formatted = f"{t0.isoformat()}Z"
print(f"Testing timestamp format: {formatted}")

# "2025-10-04T00:00:00+00:00Z" <- Potential double timezone issue

sql = f"""
SELECT DISTINCT "signalName"
FROM "iox"."WFR25"
WHERE time >= '{formatted}'
"""
print(f"Query: {sql}")

try:
    table = client.query(sql)
    print("Rows found:", table.num_rows)
    print(table.to_pandas())
except Exception as e:
    print(f"Error: {e}")

# Try without the extra Z if it has offset
formatted_clean = t0.isoformat()
print(f"\nTesting cleaner format: {formatted_clean}")
sql = f"""
SELECT DISTINCT "signalName"
FROM "iox"."WFR25"
WHERE time >= '{formatted_clean}'
"""
try:
    table = client.query(sql)
    print("Rows found:", table.num_rows)
    print(table.to_pandas())
except Exception as e:
    print(f"Error: {e}")
