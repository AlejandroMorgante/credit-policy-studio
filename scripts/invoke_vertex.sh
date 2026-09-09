#!/usr/bin/env bash
set -euo pipefail

project_id="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
region="${REGION:-us-central1}"
endpoint="${ENDPOINT_ID:-$(terraform -chdir=infra output -raw vertex_endpoint_id)}"
limit="${1:-100}"

gcloud ai endpoints predict "${endpoint}" \
  --project="${project_id}" \
  --region="${region}" \
  --json-request=- <<JSON
{"instances":[{}],"parameters":{"limit":${limit}}}
JSON
