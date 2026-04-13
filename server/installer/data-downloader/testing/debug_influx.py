
import os
import pandas as pd
from influxdb_client_3 import InfluxDBClient3

host = os.getenv("INFLUX_HOST", "http://influxdb3:8181")
token = os.getenv("INFLUX_TOKEN", "")
db = os.getenv("INFLUX_DATABASE", "WFR25")
schema = os.getenv("INFLUX_SCHEMA", "iox")
table_name = os.getenv("INFLUX_TABLE", "WFR25")

full_table = f'"{schema}"."{table_name}"'

print(f"Connecting to {host}, db={db}")
print(f"Querying table: {full_table}")

client = InfluxDBClient3(host=host, token=token, database=db)

# 1. Check time range
try:
    sql = f'SELECT MIN(time) as min_t, MAX(time) as max_t FROM {full_table}'
    print(f"Executing: {sql}")
    table = client.query(sql)
    print("Full Time Range:")
    print(table.to_pandas())

    # 1.5 Check June 2025 Specifically
    sql_june = f"""
    SELECT COUNT("time") as count 
    FROM {full_table} 
    WHERE time >= '2025-06-01T00:00:00Z' 
      AND time < '2025-07-01T00:00:00Z'
    """
    print(f"\nChecking June 2025: {sql_june}")
    table_june = client.query(sql_june)
    print(table_june.to_pandas())
except Exception as e:
    print(f"Error querying time range: {e}")

# 2. Check columns and sample data
try:
    sql = f'SELECT * FROM {full_table} LIMIT 1'
    print(f"Executing: {sql}")
    table = client.query(sql)
    print("Columns:", table.column_names)
    print("Sample Data:")
    print(table.to_pandas())
except Exception as e:
    print(f"Error querying sample data: {e}")

# 3. Check distinct signalName
try:
    sql = f'SELECT DISTINCT "signalName" FROM {full_table} LIMIT 10'
    print(f"Executing: {sql}")
    table = client.query(sql)
    print("Distinct Signals:")
    print(table.to_pandas())
except Exception as e:
    print(f"Error querying distinct signals: {e}")
