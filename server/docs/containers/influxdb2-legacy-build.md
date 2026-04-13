# Legacy InfluxDB 2 bootstrap

> **Heads up:** The project now uses InfluxDB 3 exclusively. This document is kept for historical context only.

If you need to spin up an old InfluxDB 2 instance (for example to migrate historical data) you can use the following command as a starting point:

```bash
docker run -d --name influxdb2 \
  -p 8086:8086 \
  -v ~/influxdb/data:/var/lib/influxdb2 \
  -v ~/influxdb/config:/etc/influxdb2 \
  -e DOCKER_INFLUXDB_INIT_MODE=setup \
  -e DOCKER_INFLUXDB_INIT_USERNAME=admin \
  -e DOCKER_INFLUXDB_INIT_PASSWORD=YOUR_INFLUXDB_PASSWORD \
  -e DOCKER_INFLUXDB_INIT_ORG=WFR \
  -e DOCKER_INFLUXDB_INIT_BUCKET=ourCar \
  influxdb:2
```

For current deployments use the Docker Compose stack under `installer/`, which provisions InfluxDB 3 along with Grafana and the rest of the telemetry tooling.