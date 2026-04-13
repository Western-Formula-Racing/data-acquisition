# Dockerfile for lap-detector server

# 1. Base image
FROM python:3.12-slim

# 2. Set working directory
WORKDIR /app

# 3. Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 4. Copy application code
COPY . .

# 5. Expose the port your Dash app listens on
EXPOSE 8050

# 6. Default command
CMD ["python", "lap-detector.py"]
