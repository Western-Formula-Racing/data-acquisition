FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir websockets aiohttp

# Copy application files
COPY broadcast_server.py /app/broadcast_server.py
COPY 2025-01-01-00-07-00.csv /app/2025-01-01-00-07-00.csv

# Expose WebSocket ports
EXPOSE 9080 9443

CMD ["python", "broadcast_server.py"]
