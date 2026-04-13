
import os
import slicks.config

print(f"Env INFLUX_URL: {os.environ.get('INFLUX_URL')}")
print(f"slicks.config.INFLUX_URL: {getattr(slicks.config, 'INFLUX_URL', 'Not Set')}")
print(f"slicks.config.INFLUX_DB: {getattr(slicks.config, 'INFLUX_DB', 'Not Set')}")
