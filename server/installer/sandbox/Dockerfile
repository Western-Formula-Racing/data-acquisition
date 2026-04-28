FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Pre-download the FastEmbed ONNX model so first startup is instant
RUN python -c "from langchain_community.embeddings import FastEmbedEmbeddings; FastEmbedEmbeddings()"

# Copy application code
COPY code_generator.py .
COPY stats_report.py .
COPY prompt-guide.txt.example ./
# prompt-guide.txt is optional (local customization); fall back to example if absent
RUN if [ ! -f prompt-guide.txt ]; then cp prompt-guide.txt.example prompt-guide.txt; fi

# Create directories for generated code, ChromaDB, and cache
RUN mkdir -p /app/generated /app/chroma_db /app/cache

# Expose port
EXPOSE 3030

# Run the service
CMD ["python", "code_generator.py"]
