FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir websockets aiohttp

# Copy application (no CSV required — server self-generates via simulators)
COPY broadcast_server.py /app/broadcast_server.py

# Expose WebSocket ports
EXPOSE 9080 9443

CMD ["python", "broadcast_server.py"]
