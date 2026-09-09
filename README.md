# Credit Policy Studio

A polished proof of concept for editing, versioning, executing, and explaining deterministic credit
decision policies on Google Cloud. Business users work with a visual tree; a Python runtime reads a
cohort from BigQuery, evaluates an explicitly selected candidate or the productive JSON policy,
writes auditable results back to BigQuery, and returns the exact version and hash used by the run.

## Current POC scope

The UI runs only on the developer's computer. It is not publicly exposed and Cloud Run is not needed
for the current proof of concept.

```text
Browser
  └── localhost:8080 (HTML UI + small FastAPI facade)
          └── Vertex AI endpoint
                  ├── reads applicants from BigQuery
                  ├── loads the active JSON policy from Cloud Storage
                  ├── evaluates the complete cohort
                  ├── writes results and traces to BigQuery
                  └── returns run_id + policy version + summary
```

The browser calls only localhost. FastAPI invokes Vertex with the developer's Application Default
Credentials, so no Google Cloud token, API key, or service-account credential is embedded in HTML or
committed to this repository. The dashboard also uses the local backend to query BigQuery.

Cloud Run, scheduled jobs, and asynchronous execution are documented as future evolutions. They are
not required to demonstrate the current flow.

## GCP infrastructure at a glance

| Service | Current POC responsibility | Created now? |
| --- | --- | --- |
| Vertex AI Endpoint | Hosts the Python scoring container and starts one synchronous evaluation run per request. | Yes |
| BigQuery | Stores the synthetic applicant cohort, one result per applicant, and one audit row per run. | Yes |
| Cloud Storage | Stores candidate policies, immutable SHA-addressed revisions, and the productive pointer. | Yes |
| Artifact Registry | Stores the container image deployed to Vertex AI. | Yes |
| Cloud Build | Builds and pushes that image without requiring a local registry login. | API enabled; used by `make image` |
| IAM service account | Gives the Vertex runtime read access to policies and read/write access to the POC dataset. | Yes |
| Cloud Run | Would host the UI later; the POC intentionally keeps it on localhost. | No (`deploy_ui=false`) |
| Scheduler / Job runtime | Would automate or decouple large recurring cohorts later. | No |

Terraform also enables the required service APIs. It creates an empty Vertex endpoint, but the
billable serving replica is created only by `make deploy-model`. No VPC, load balancer, database,
API key, service-account key, or public web endpoint is created for the current POC.

> [!WARNING]
> Every person, score, rule, and outcome in this repository is fictional. This software is a UX and
> architecture demonstration, not a credit policy and not suitable for real lending decisions.

## What is included

- A typed Python decision engine with graph, reference, and cycle validation.
- Vertex-compatible `/health` and `/predict` routes (`instances` in, `predictions` out).
- Mutable candidate workspaces with immutable SHA-addressed revisions and an exact productive pointer.
- BigQuery input, per-user results, execution metadata, policy hash, and ordered decision traces.
- A warm, dependency-free HTML/CSS/JavaScript editor and impact dashboard.
- A least-privilege Vertex runtime service account; an additional UI identity is created only if the
  optional Cloud Run deployment is enabled later.
- Portable Terraform, a two-stage deployment Makefile, synthetic seed SQL, tests, and CI.

## Business-user workflow

The product behaves as a small policy laboratory:

1. In **Política**, explicitly select the **Versión a editar**. Productive versions are visible but
   read-only; create a candidate before changing one.
2. Edit a rule and apply it. Each apply persists to that same candidate and creates an addressable
   SHA-256 revision without changing production.
3. Open **Evaluación**, select any version, and run it against the test dataset.
4. Browse all runs for that version and inspect one at a time. Dashboard figures are filtered by
   `run_id` and never accumulate multiple runs in the visible result.
5. Promote an evaluated version to **Productiva**. Consumers that omit `policy_version` resolve this
   production pointer.

The `?` button in the application opens the same flow as an in-product quick guide. See the complete
[business-user guide](docs/user-guide.md), including rollback semantics and the distinction between
editing a candidate, creating a version, evaluating it, and promoting it.

The **Versiones** library lists every policy and its Productiva/Candidata state. Candidates can be
updated repeatedly through the explicit editor selector; productive versions are frozen. Evaluation
also lists every run for the selected version; choosing a run filters the dashboard by its exact
`run_id`. Switching versions never overwrites the in-progress editor workspace.

![Architecture](https://img.shields.io/badge/GCP-Vertex_AI_%7C_BigQuery_%7C_GCS-ef895e)
![Python](https://img.shields.io/badge/Python-3.11%2B-3a3530)
![License](https://img.shields.io/badge/license-MIT-dceadf)

## Local demo

Requirements: Python 3.11+, GNU Make, and optionally Docker and Terraform.

```bash
make setup
make test
make run
```

Open <http://localhost:8080>. Without `VERTEX_ENDPOINT_ID`, local mode uses eight in-memory fictional
applicants. Edit a threshold, create a candidate version, open **Evaluación**, select it, run the
dataset, and promote it only if the result is acceptable.

To use the real POC flow from localhost, create an ignored `.env` from `.env.example` and set:

```dotenv
APP_ENV=gcp
GCP_PROJECT_ID=your-project-id
GCP_REGION=us-central1
BIGQUERY_LOCATION=US
POLICY_BUCKET=your-project-id-credit-policy-studio
VERTEX_ENDPOINT_ID=your-endpoint-id
```

With `APP_ENV=gcp`, the local backend reads the dashboard from BigQuery and stores candidate policies
in Cloud Storage. With `VERTEX_ENDPOINT_ID` present, **Iniciar evaluación** invokes Vertex instead of
running the engine inside the local FastAPI process. `make run` reads this ignored `.env`; ADC remains
on the developer's machine.

The Vertex-compatible request is intentionally almost empty because the runtime reads the cohort:

```bash
curl -X POST http://localhost:8080/predict \
  -H 'Content-Type: application/json' \
  -d '{"instances":[{}],"parameters":{"limit":100}}'
```

Each run returns lineage such as:

```json
{
  "predictions": [{
    "run_id": "6d2e...",
    "policy_id": "consumer-credit-poc",
    "policy_version": "2026-09-09.1",
    "policy_sha256": "2bf5...",
    "processed_rows": 100,
    "persisted_rows": 100,
    "decisions": {"APPROVED": 58, "REVIEW": 27, "REJECTED": 15}
  }]
}
```

## Provision the GCP side in any project

Authentication uses Application Default Credentials; the repository stores no credentials.
Run `make setup` once so the policy publication script can validate and canonically hash the JSON
with the same Python model used by Vertex.

```bash
gcloud auth application-default login --project=YOUR_PROJECT_ID
export PROJECT_ID=YOUR_PROJECT_ID
export REGION=us-central1

make tf-init
make tf-plan                # read the plan before creating resources
make infra-core             # APIs, IAM, GCS, BigQuery, Artifact Registry, endpoint
make upload-policy
make seed
make image
make deploy-model           # creates billable Vertex serving replicas
./scripts/invoke_vertex.sh 100
```

The model deployment uses at least one `n1-standard-2` prediction replica and therefore incurs cost
until undeployed. Terraform protects BigQuery tables by default and does not make the UI public.
The operator applying Terraform needs permission to enable APIs and create the resources above; the
operator deploying the model must also be allowed to use the Vertex runtime service account.

## Future: expose the UI with Cloud Run

The Terraform configuration can later expose the same UI/API image through authenticated Cloud Run.
This is intentionally outside the current localhost POC. After publishing the image:

```bash
terraform -chdir=infra apply \
  -var="project_id=${PROJECT_ID}" \
  -var="container_image=${IMAGE}" \
  -var="deploy_ui=true"
```

Keep `allow_unauthenticated_ui=false`. Grant intended users `roles/run.invoker` on the Cloud Run
service using your organization's group rather than placing credentials or broad OAuth scopes in
browser code.

## Repository map

```text
src/credit_policy_studio/   Python engine, repositories, BigQuery adapter, API, Vertex client
policies/                   Example versioned decision policy
web/                        Visual editor and impact dashboard
infra/                      Terraform and BigQuery schemas
sql/                        Synthetic applicant seed
scripts/                    Policy publication, model deployment, invocation
tests/                      Engine and Vertex contract tests
docs/                       Architecture and data contract
```

Read [the architecture](docs/architecture.md) for trust boundaries and the production evolution,
and [the data contract](docs/data-contract.md) for the fictional feature meanings.

## Contribution quality convention: Apache Magpie

This project uses [Apache Magpie](https://github.com/apache/magpie) as its shared convention for
repository health and pull-request review. Each contributor installs Magpie manually in their own
agent environment, following the upstream installation instructions. Keep that installation outside
this repository: do not commit a Magpie checkout, snapshot, generated symlinks, or user configuration.

Before opening or approving a pull request:

1. Authors run `magpie-pairing-self-review` against their change and resolve verified findings.
2. Maintainers use `magpie-pr-management-code-review` for the final PR review.
3. Changes to dependencies, workflows, licensing, or CI also run the applicable `repo-health` skill,
   such as `magpie-dependency-audit`, `magpie-workflow-security-audit`,
   `magpie-license-compliance-audit`, or `magpie-ci-runner-audit`.
4. The PR description records which checks were run and any accepted exceptions.

Magpie complements the deterministic project checks; it does not replace `make lint`, `make test`,
Terraform validation, or review of the infrastructure plan.

## Design choices

- Human versions are readable; SHA-256 makes the exact policy content verifiable.
- A consumer run resolves the productive pointer once, preventing mixed policy versions within a
  cohort. A laboratory run snapshots its explicitly selected candidate revision once.
- Historical output stores the traversed path, so the dashboard never needs to reconstruct old trees.
- In the current POC, the browser talks only to localhost and the FastAPI facade uses the developer's
  ADC to call Vertex, BigQuery, and Cloud Storage. If Cloud Run is enabled later, the same facade uses
  its dedicated service account. No Google credential is sent to the browser in either design.
- Large production cohorts should run as Vertex Custom Jobs or Cloud Run Jobs instead of using a
  synchronous online endpoint. The engine and output contract remain reusable.

## License

[MIT](LICENSE)
