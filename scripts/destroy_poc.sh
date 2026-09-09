#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID is required}"
: "${REGION:?REGION is required}"

if [[ "${CONFIRM_DESTROY:-}" != "${PROJECT_ID}" ]]; then
  echo "Destruction blocked. Re-run with CONFIRM_DESTROY=${PROJECT_ID}" >&2
  exit 2
fi

endpoint="$(terraform -chdir=infra output -raw vertex_endpoint_id 2>/dev/null || true)"

if [[ -n "${endpoint}" ]]; then
  while IFS=',' read -r deployed_model_id _model_resource; do
    [[ -z "${deployed_model_id}" ]] && continue
    echo "Undeploying Vertex model ${deployed_model_id} from endpoint ${endpoint}"
    gcloud ai endpoints undeploy-model "${endpoint}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --deployed-model-id="${deployed_model_id}" \
      --quiet
  done < <(
    gcloud ai endpoints describe "${endpoint}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --flatten="deployedModels[]" \
      --format="csv[no-heading](deployedModels.id,deployedModels.model)"
  )
fi

while IFS= read -r model_resource; do
  [[ -z "${model_resource}" ]] && continue
  echo "Deleting Vertex model ${model_resource}"
  gcloud ai models delete "${model_resource}" \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --quiet
done < <(
  gcloud ai models list \
    --project="${PROJECT_ID}" \
    --region="${REGION}" \
    --filter="labels.application=credit-policy-studio" \
    --format="value(name)"
)

terraform -chdir=infra destroy \
  -var="project_id=${PROJECT_ID}" \
  -var="region=${REGION}" \
  -var="bigquery_location=${BQ_LOCATION:-US}" \
  -var="deletion_protection=false" \
  -var="force_destroy_data=true" \
  -auto-approve

echo "Credit Policy Studio infrastructure was removed from ${PROJECT_ID}."
