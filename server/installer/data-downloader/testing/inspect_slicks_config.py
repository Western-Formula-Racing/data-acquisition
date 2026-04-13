
import slicks
import inspect

# 1. Print connect_influxdb3 source
if hasattr(slicks, 'connect_influxdb3'):
    print("Source of connect_influxdb3:")
    print(inspect.getsource(slicks.connect_influxdb3))

# 2. Check config values before and after
import slicks.config
print("\nConfig BEFORE:")
print(f"INFLUX_URL: {getattr(slicks.config, 'INFLUX_URL', 'Not Set')}")
print(f"INFLUX_DB: {getattr(slicks.config, 'INFLUX_DB', 'Not Set')}")

print("\nCalling connect_influxdb3...")
slicks.connect_influxdb3(
    url="http://test-host:9999",
    token="test-token",
    db="test-db"
)

print("\nConfig AFTER:")
print(f"INFLUX_URL: {getattr(slicks.config, 'INFLUX_URL', 'Not Set')}")
print(f"INFLUX_DB: {getattr(slicks.config, 'INFLUX_DB', 'Not Set')}")
