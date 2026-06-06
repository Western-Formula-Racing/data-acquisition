FROM python:3.12-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Best-effort FastEmbed ONNX prefetch. Do not fail image builds when external
# model hosts rate-limit CI; the service can download the model at runtime.
RUN python -c "from langchain_community.embeddings import FastEmbedEmbeddings; FastEmbedEmbeddings()" \
    || echo "FastEmbed model prefetch failed; continuing build"

# Copy application code
COPY code_generator.py .
COPY stats_report.py .
# Use the wildcard so an existing prompt-guide.txt is preferred; otherwise
# fall back to .example. The previous version only copied .example, which
# silently ignored the active prompt-guide.txt customization.
COPY prompt-guide.txt* ./
RUN if [ ! -f prompt-guide.txt ]; then cp prompt-guide.txt.example prompt-guide.txt; fi

# Create directories for generated code, ChromaDB, and cache
RUN mkdir -p /app/generated /app/chroma_db /app/cache

# Expose port
EXPOSE 3030

# Run the service
CMD ["python", "code_generator.py"]
