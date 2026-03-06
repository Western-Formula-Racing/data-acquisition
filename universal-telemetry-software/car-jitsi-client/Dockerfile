# Headless Jitsi Client for Car RPI
# Runs Chromium in headless mode with PulseAudio for driver audio

FROM node:20-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    pulseaudio \
    alsa-utils \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY index.js .

# Environment variables (override at runtime)
ENV JITSI_URL=http://192.168.1.1:8000
ENV ROOM_NAME=wfr-comms
ENV DISPLAY_NAME=Driver
ENV RETRY_INTERVAL_MS=5000
ENV MAX_RETRIES=-1
ENV ENABLE_AUDIO=true
ENV ENABLE_VIDEO=false

CMD ["npm", "start"]
