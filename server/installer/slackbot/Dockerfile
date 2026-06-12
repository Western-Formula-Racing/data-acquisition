FROM python:3.12-slim

# Set working dir
WORKDIR /app

RUN mkdir -p /app/logs

# Install CA certificates and SSL dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy bot source and assets
COPY slack_bot.py lappy_test_image.png ./

# Set default command
CMD ["python", "slack_bot.py"]
