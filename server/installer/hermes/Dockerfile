# Hermes Agent (NousResearch) in a slim container, on the installer network so
# its `terminal` toolset can reach timescaledb via psql. Run with --memory=4g.
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        postgresql-client ripgrep git curl ca-certificates jq \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir hermes-agent

# Seed ~/.hermes/.env from env vars on first run (keys are injected at runtime,
# never baked into the image).
COPY entrypoint.sh /usr/local/bin/hermes-entrypoint
RUN chmod +x /usr/local/bin/hermes-entrypoint

WORKDIR /work
ENTRYPOINT ["/usr/local/bin/hermes-entrypoint"]
CMD ["hermes", "doctor"]
