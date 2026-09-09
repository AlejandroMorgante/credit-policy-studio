FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
COPY policies ./policies
COPY web ./web

RUN pip install --no-cache-dir ".[aws]"

RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080

# ENTRYPOINT, not CMD: SageMaker starts the container as `docker run <image> serve`,
# which would replace a CMD entirely. The extra argument lands on $0 and is ignored.
# SAGEMAKER_BIND_TO_PORT is set by SageMaker; PORT covers Vertex, Cloud Run and local runs.
ENTRYPOINT ["sh", "-c", "uvicorn credit_policy_studio.api:app --host 0.0.0.0 --port ${SAGEMAKER_BIND_TO_PORT:-$PORT}"]
