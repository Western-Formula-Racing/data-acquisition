FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY code_generator.py .
COPY prompt-guide.txt* prompt-guide.txt.example ./
RUN if [ ! -f prompt-guide.txt ]; then \
      echo "WARNING: prompt-guide.txt not found, using prompt-guide.txt.example"; \
      cp prompt-guide.txt.example prompt-guide.txt; \
    fi

# Create directory for generated code
RUN mkdir -p /app/generated

# Expose port
EXPOSE 3030

# Run the service
CMD ["python", "code_generator.py"]
