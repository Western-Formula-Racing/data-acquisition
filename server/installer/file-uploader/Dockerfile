FROM python:3.11-slim

RUN apt-get update && apt-get install -y curl unzip \
    && apt-get clean

WORKDIR /app

COPY requirements.txt .

RUN pip install --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

    # COPY . .
# VOLUME [ "./" ]

RUN useradd -m -u 1000 appuser && chown -R appuser:appuser /app
USER appuser

HEALTHCHECK --interval=30s --timeout=30s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8084/health || exit 1

CMD [ "python3", "app.py"]