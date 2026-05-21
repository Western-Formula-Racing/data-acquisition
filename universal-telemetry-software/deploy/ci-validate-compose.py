#!/usr/bin/env python3
"""Validate docker-compose.macbook-base.yml structure and configuration."""
import sys
import yaml

COMPOSE_PATH = "universal-telemetry-software/deploy/docker-compose.macbook-base.yml"

with open(COMPOSE_PATH) as f:
    doc = yaml.safe_load(f)

services = list(doc.get("services", {}).keys())
print(f"Services: {services}")

required = ["telemetry", "pecan", "redis"]
for svc in required:
    assert svc in services, f"Missing required service: {svc}"

# Verify no local build directives
for name, cfg in doc.get("services", {}).items():
    assert "build" not in cfg, f"Service {name} still has build: directive — strip it"

print("Compose file valid — all services present, no local build directives")
