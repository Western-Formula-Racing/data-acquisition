FROM python:3.11-slim

WORKDIR /app

# Install system dependencies for CAN, networking, and GStreamer (Audio/Video)
RUN apt-get update && apt-get install -y \
    can-utils \
    iproute2 \
    iptables \
    curl \
    python3-gi \
    python3-gst-1.0 \
    gir1.2-gstreamer-1.0 \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    gstreamer1.0-alsa \
    libgirepository1.0-dev \
    libgirepository-2.0-dev \
    libcairo2-dev \
    pkg-config \
    gcc \
    python3-dev \
    libglib2.0-dev \
    libgl1 \
    gobject-introspection \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY src/ /app/src/
COPY status/ /app/status/
COPY web-tester/ /app/web-tester/
COPY main.py /app/.
COPY example.dbc /app/example.dbc

# Use environment variables for configuration
ENV ROLE=auto
ENV REMOTE_IP=192.168.1.100
ENV UDP_PORT=5005
ENV TCP_PORT=5006
ENV REDIS_URL=redis://localhost:6379/0
ENV ENABLE_AUDIO=true
ENV ENABLE_VIDEO=true

CMD ["python", "main.py"]