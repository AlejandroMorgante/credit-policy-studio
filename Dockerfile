# GCP runtime image: Cloud Storage + BigQuery + Vertex AI.
# The AWS image is Dockerfile.aws; each declares exactly one cloud SDK.
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
COPY policies ./policies
COPY web ./web
COPY docker/serve /usr/local/bin/serve

RUN pip install --no-cache-dir ".[gcp]"

RUN chmod +x /usr/local/bin/serve
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

# `serve` is the name SageMaker invokes; CMD covers hosts that pass no arguments.
CMD ["serve"]
