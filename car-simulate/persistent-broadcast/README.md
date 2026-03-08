# Persistent WebSocket Broadcast Server

This Docker Compose setup provides a persistent WebSocket server that broadcasts realistic CAN data to connected clients on both `ws://` and `wss://` protocols.

By default it uses **class-based simulators** rather than CSV playback:

- Standard 11-bit IDs (e.g. `VCU_Status` 192, `BMS_Status` 512, `Wheel_Speeds` 768)
- Extended 29-bit charger IDs from `example.dbc` (e.g. `0x1806E5F4`, `0x18FF50E5`)
- High-rate accumulator messages (cell voltages and temperatures)

You can still optionally replay a recorded CSV log by enabling `ENABLE_CSV=true`.

## Features

- **Dual Protocol Support**: Broadcasts on both WebSocket (ws) and Secure WebSocket (wss)
- **Persistent Operation**: Automatically restarts if the container crashes
- **Realistic Simulation**: Continuously generates CAN traffic from simulators
- **Optional CSV Playback**: Can cycle through a CSV log if desired
- **Multi-Client**: Supports multiple simultaneous client connections
- **Domain Ready**: Configured for `ws-wfr.0001200.xyz` via Cloudflare

## Prerequisites

1. **SSL Certificates** (for wss://): Generate or obtain SSL certificates for secure connections
2. (Optional) **CSV Data File**: Only needed if you enable CSV replay

## Setup

### 1. (Optional) Copy a CSV file for recorded-log replay

If you want to replay a recorded log instead of (or in addition to) the built-in
simulators, copy a CSV file into this directory and set `ENABLE_CSV=true` and
`CSV_FILE=/app/<your-file>.csv` in `docker-compose.yml`.

### 2. SSL Certificates (Optional for WSS)

For local development with self-signed certificates:

```bash
mkdir -p ssl
openssl req -x509 -newkey rsa:4096 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes -subj "/CN=ws-wfr.0001200.xyz"
```

**For production with Cloudflare:**

You have two options:

#### Option A: Cloudflare Tunnel (Recommended)
Use Cloudflare Tunnel to expose your WebSocket server without managing SSL certificates:

1. Install cloudflared: `brew install cloudflare/cloudflare/cloudflared`
2. Login: `cloudflared tunnel login`
3. Create tunnel: `cloudflared tunnel create wfr-websocket`
4. Configure tunnel (see Cloudflare Tunnel section below)

#### Option B: Origin Certificates
Use Cloudflare Origin certificates (for Orange Cloud mode):

1. Go to your Cloudflare dashboard → SSL/TLS → Origin Server
2. Create a certificate for `ws-wfr.0001200.xyz`
3. Save the certificate as `ssl/cert.pem` and private key as `ssl/key.pem`

### 3. Start the Server

```bash
docker-compose up -d
```

### 4. Check Logs

```bash
docker-compose logs -f
```

## Cloudflare Configuration

### DNS Settings

Add an A record in Cloudflare DNS:
- **Type**: A
- **Name**: ws-wfr
- **IPv4 Address**: Your server's public IP
- **Proxy status**: DNS only (grey cloud) OR Proxied (orange cloud) if using Tunnel

### Cloudflare Tunnel Setup (Recommended)

Create a `cloudflared` configuration file:

```yaml
# cloudflared-config.yml
tunnel: <your-tunnel-id>
credentials-file: /path/to/credentials.json

ingress:
  - hostname: ws-wfr.0001200.xyz
    service: ws://localhost:9080
  - service: http_status:404
```

Run cloudflared:
```bash
cloudflared tunnel --config cloudflared-config.yml run
```

Or add to docker-compose.yml:
```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --config /etc/cloudflared/config.yml run
    volumes:
      - ./cloudflared-config.yml:/etc/cloudflared/config.yml:ro
      - ./tunnel-credentials.json:/etc/cloudflared/credentials.json:ro
    restart: unless-stopped
    networks:
      - broadcast-network
```

## Usage

### Connect from Client

```javascript
// WebSocket (unencrypted)
const ws = new WebSocket('ws://ws-wfr.0001200.xyz');

// Secure WebSocket (encrypted)
const wss = new WebSocket('wss://ws-wfr.0001200.xyz');

ws.onmessage = (event) => {
  const batch = JSON.parse(event.data);
  console.log(`Received ${batch.length} CAN messages`);
  // Process messages...
};
```

### Python Client Example

```python
import asyncio
import websockets
import json

async def connect():
    uri = "ws://ws-wfr.0001200.xyz"
    async with websockets.connect(uri) as websocket:
        while True:
            message = await websocket.recv()
            batch = json.loads(message)
            print(f"Received {len(batch)} messages")

asyncio.run(connect())
```

## Data Format

The server broadcasts batches of 100 CAN messages at 5 Hz. Each message has the following format:

```json
{
  "time": 1234567890,
  "canId": 256,
  "data": [0, 1, 2, 3, 4, 5, 6, 7]
}
```

## Management Commands

```bash
# Start the server
docker-compose up -d

# Stop the server
docker-compose down

# View logs
docker-compose logs -f

# Restart the server
docker-compose restart

# Rebuild and restart
docker-compose up -d --build
```

## Port Configuration

- **8080**: WebSocket (ws://) - unencrypted
- **8443**: Secure WebSocket (wss://) - encrypted

## Troubleshooting

### Connection Refused
- Check if the container is running: `docker-compose ps`
- Verify ports are exposed: `docker-compose port websocket-server 9080`
- Check firewall settings

### SSL Certificate Errors
- Ensure certificates are in the `ssl/` directory
- Verify certificate permissions
- For Cloudflare, use Flexible SSL mode or Origin Certificates

### No Data Broadcasting
- If using CSV: verify the CSV file exists, `ENABLE_CSV=true`, and `CSV_FILE` points to the correct path
- If using only simulators: check logs to confirm the accumulator, standard CAN, and charger simulators started

## Environment Variables

You can customize the following variables in `docker-compose.yml`:

- `WS_PORT`: WebSocket port (default: 8080)
- `WSS_PORT`: Secure WebSocket port (default: 8443)
- `CSV_FILE`: Path to CSV data file
- `SSL_CERT`: Path to SSL certificate
- `SSL_KEY`: Path to SSL private key
- `DOMAIN`: Domain name for the service
