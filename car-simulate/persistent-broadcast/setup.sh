#!/bin/bash

# Setup script for persistent WebSocket broadcast server

set -e

echo "=== WebSocket Broadcast Server Setup ==="

# Check if CSV file exists
DEFAULT_CSV="2025-01-01-00-00-00.csv"
if [ ! -f "$DEFAULT_CSV" ]; then
    echo "Copying CSV data file..."
    if [ -f "../$DEFAULT_CSV" ]; then
        cp "../$DEFAULT_CSV" .
        echo "✓ CSV file copied"
    else
        echo "⚠ Warning: CSV file not found. Please copy $DEFAULT_CSV to this directory."
    fi
else
    echo "✓ CSV file already exists"
fi

# Create SSL directory if it doesn't exist
mkdir -p ssl

# Check if SSL certificates exist
if [ ! -f "ssl/cert.pem" ] || [ ! -f "ssl/key.pem" ]; then
    echo ""
    read -p "Do you want to generate self-signed SSL certificates? (y/n) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "Generating self-signed SSL certificates..."
        openssl req -x509 -newkey rsa:4096 -keyout ssl/key.pem -out ssl/cert.pem -days 365 -nodes \
            -subj "/CN=ws-wfr.0001200.xyz" 2>/dev/null
        echo "✓ SSL certificates generated"
        echo "⚠ Note: These are self-signed certificates. For production, use Cloudflare Origin Certificates or Cloudflare Tunnel."
    else
        echo "⚠ Skipping SSL certificate generation"
        echo "  For WSS support, add certificates to ssl/cert.pem and ssl/key.pem"
    fi
else
    echo "✓ SSL certificates already exist"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Start the server: docker-compose up -d"
echo "2. View logs: docker-compose logs -f"
echo "3. Configure Cloudflare DNS: ws-wfr.0001200.xyz -> Your server IP"
echo ""
echo "WebSocket URLs:"
echo "  ws://ws-wfr.0001200.xyz"
echo "  wss://ws-wfr.0001200.xyz (if SSL configured)"
echo ""
