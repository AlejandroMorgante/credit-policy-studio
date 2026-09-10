#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${REGION:?REGION is required}"
: "${IMAGE:?IMAGE is required}"

bigquery_location="${BQ_LOCATION:-US}"

endpoint="$(terraform -chdir=infra output -raw vertex_endpoint_id)"
runtime_sa="$(terraform -chdir=infra output -raw vertex_runtime_service_account)"
bucket="$(terraform -chdir=infra output -raw policy_bucket)"
dataset="$(terraform -chdir=infra output -raw bigquery_dataset)"
release="$(date -u +%Y%m%d-%H%M%S)"
display_name="credit-policy-${release}"
previous_deployments="$(mktemp)"
trap 'rm -f "${previous_deployments}"' EXIT

gcloud ai endpoints describe "${endpoint}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --flatten='deployedModels[]' \
  --format='value(deployedModels.id)' >"${previous_deployments}"

gcloud ai models upload \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --display-name="${display_name}" \
  --labels="application=credit-policy-studio" \
  --container-image-uri="${IMAGE}" \
  --container-health-route="/health" \
  --container-predict-route="/predict" \
  --container-ports=8080 \
  --container-env-vars="APP_ENV=gcp,GCP_PROJECT_ID=${PROJECT_ID},GCP_REGION=${REGION},BIGQUERY_LOCATION=${bigquery_location},BIGQUERY_DATASET=${dataset},POLICY_BUCKET=${bucket}"

model="$(gcloud ai models list \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --filter="displayName=${display_name}" \
  --sort-by='~createTime' \
  --limit=1 \
  --format='value(name)')"

if [[ -z "${model}" ]]; then
  echo "The uploaded model could not be resolved" >&2
  exit 1
fi

gcloud ai endpoints deploy-model "${endpoint}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --model="${model}" \
  --display-name="${display_name}" \
  --machine-type="n1-standard-2" \
  --min-replica-count=1 \
  --max-replica-count=2 \
  --service-account="${runtime_sa}" \
  --traffic-split=0=100

while IFS= read -r deployed_model_id; do
  if [[ -z "${deployed_model_id}" ]]; then
    continue
  fi
  gcloud ai endpoints undeploy-model "${endpoint}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --deployed-model-id="${deployed_model_id}" \
    --quiet
done <"${previous_deployments}"

echo "Deployed ${model} to ${endpoint}"
