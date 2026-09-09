#!/usr/bin/env bash
set -euo pipefail

policy_file="${1:-}"
project_id="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"

if [[ -z "${policy_file}" || ! -f "${policy_file}" ]]; then
  echo "Usage: PROJECT_ID=my-project $0 path/to/policy.json" >&2
  exit 2
fi
if [[ -z "${project_id}" ]]; then
  echo "PROJECT_ID is required" >&2
  exit 2
fi

bucket="$(terraform -chdir=infra output -raw policy_bucket)"
policy_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["metadata"]["policy_id"])' "${policy_file}")"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["metadata"]["version"])' "${policy_file}")"
python_bin="${PYTHON_BIN:-.venv/bin/python}"
if [[ ! -x "${python_bin}" ]]; then
  echo "${python_bin} is unavailable; run 'make setup' or set PYTHON_BIN" >&2
  exit 2
fi
policy_sha256="$(PYTHONPATH=src "${python_bin}" -c 'import sys; from pathlib import Path; from credit_policy_studio.engine import policy_sha256; from credit_policy_studio.models import CreditPolicy; policy=CreditPolicy.model_validate_json(Path(sys.argv[1]).read_text()); print(policy_sha256(policy))' "${policy_file}")"
object="policies/${policy_id}/${version}.json"
revision_object="policies/${policy_id}/${version}/revisions/${policy_sha256}.json"

# Generation zero is an immutable-create precondition: duplicate versions fail.
gcloud storage cp "${policy_file}" "gs://${bucket}/${object}" \
  --project="${project_id}" \
  --if-generation-match=0
gcloud storage cp "${policy_file}" "gs://${bucket}/${revision_object}" \
  --project="${project_id}" \
  --if-generation-match=0

generation="$(gcloud storage objects describe "gs://${bucket}/${object}" --format='value(generation)')"
pointer_file="$(mktemp)"
trap 'rm -f "${pointer_file}"' EXIT
printf '{"policy_id":"%s","version":"%s","object":"%s","generation":%s}\n' \
  "${policy_id}" "${version}" "${object}" "${generation}" > "${pointer_file}"
gcloud storage cp "${pointer_file}" "gs://${bucket}/policies/active.json" --project="${project_id}"

echo "Published ${policy_id}@${version} (generation ${generation})"
