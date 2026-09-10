# Credit Policy Studio on AWS

Read [the architecture](architecture.md) first: it describes the runtime flow, the policy
publication model, the explainability contract and the trust boundaries once, for both clouds.
This document is the AWS companion — what maps to what, and the places where the mechanism
genuinely differs.

![Credit Policy Studio architecture on AWS](assets/credit-policy-studio-architecture-aws.png)

## Service mapping

| Concern | Google Cloud | AWS |
| --- | --- | --- |
| Policy storage | Cloud Storage, object generations | S3, versioning + conditional writes |
| Warehouse | BigQuery | Athena over S3, Glue Data Catalog |
| Scoring runtime | Vertex AI endpoint | SageMaker endpoint |
| Registry | Artifact Registry + Cloud Build | ECR + `docker build` |
| Runtime identity | Service account | IAM role |
| Provisioning | Terraform (`infra/`) | Terraform (`infra/aws/`) |

Both clouds coexist. `CLOUD_PROVIDER` (`local` | `gcp` | `aws`) selects the adapter set;
`engine.py`, `service.py`, `models.py` and `web/` are cloud-agnostic and are not touched.

The AWS adapters live in `src/credit_policy_studio/aws.py`, imported lazily from `dependencies.py`.
Each cloud SDK is an optional extra (`.[aws]`, `.[gcp]`) and each Dockerfile installs exactly one, so
an image never carries the other cloud's SDK.

## Policy storage

`ObjectPolicyRepository` holds the publication logic once, over an `ObjectStore` seam. Only the store
is cloud-specific:

| GCS | S3 |
| --- | --- |
| `blob.generation` | `VersionId` |
| `if_generation_match=0` (create only) | `PutObject(IfNoneMatch="*")` |
| `if_generation_match=g` (unchanged only) | `PutObject(IfMatch=etag)` |
| `list_blobs(prefix=...)` | `list_objects_v2(Prefix=..., Delimiter="/")` |

Failed conditional writes become `FileExistsError` and `FileNotFoundError`, which the API already
translates to HTTP 409 and 404, so no cloud exception reaches the API layer.

The active pointer keeps its shape, with `generation` replaced by `version_id`. Legacy pointers
written by `scripts/publish_policy.sh` still carry `generation` and are read unchanged.

## Warehouse

Athena reads external Glue tables over newline-delimited JSON on S3:

```
s3://<data_bucket>/applicants/applicants.json
s3://<data_bucket>/scoring_results/run_id=<run_id>/<uuid>.json
s3://<data_bucket>/scoring_runs/<run_id>.json
s3://<data_bucket>/athena-results/
```

**Writes are plain `PutObject` calls**, one object per run, replacing BigQuery's streaming inserts.
No DML, no table maintenance, and no exposure to the Athena query-size limit on large decision
traces. The trade-off is one small object per run; the upgrade path is an Iceberg table with periodic
compaction, marked with a `ponytail:` comment in `AthenaWarehouse`.

`scoring_results` is partitioned by `run_id` using **partition projection** (`injected`), so Athena
derives the S3 prefix from the `WHERE` clause: no crawler, no `MSCK REPAIR`. This works because every
dashboard query filters by `run_id`. A query that does not is rejected rather than scanning
everything.

### SQL translation

| BigQuery | Trino / Athena |
| --- | --- |
| `` `project.dataset.table` `` | `"credit_policy"."scoring_results"` |
| `@param` | `?` positional parameter |
| `JSON_QUERY_ARRAY(trace_json)` | `CAST(json_parse(trace_json) AS array(json))` |
| `UNNEST(...) AS step` | `CROSS JOIN UNNEST(...) AS t(step)` |
| `JSON_VALUE(step, '$.node_id')` | `json_extract_scalar(step, '$.node_id')` |
| `ANY_VALUE(label)` | `arbitrary(label)` |

Queries stay parameterized through Athena `ExecutionParameters`. The one exception is `LIMIT`, which
Athena will not accept as a placeholder; it is interpolated as an `int()` after `PredictionParameters`
has already bounded it.

Timestamps are stored as ISO-8601 strings and ordered with `from_iso8601_timestamp()`, rather than
relying on lexicographic order. `decisions` is stored as `decisions_json` and parsed back on read, so
`list_runs` returns the same shape the UI already consumes.

## Scoring runtime

SageMaker's container contract is `GET /ping` and `POST /invocations`. The app already exposed
`/ping`; `/invocations` is an alias of the existing `/predict` handler, so one payload shape serves
both clouds.

Two container requirements cost real time to discover, and neither is obvious:

- **SageMaker starts containers as `docker run <image> serve`.** The image must carry an executable
  named `serve` on PATH (`docker/serve`), with `CMD ["serve"]` for hosts that pass no argument.
  Passing the argument to uvicorn instead fails with `Got unexpected extra argument (serve)`.
- **Serverless Inference will not provision a container that switches to a non-root user**, and
  reports only `Request to service failed` with no container log when it refuses. The AWS image
  therefore runs as root; the GCP image keeps its unprivileged user.

`SageMakerInvoker` mirrors `VertexInvoker`, and `api.py::create_run` selects between them from
`CLOUD_PROVIDER`. Credentials come from the standard boto3 chain, so none reach the browser or the
repository.

## Infrastructure

`infra/aws/` is a separate Terraform root: versioned and encrypted S3 buckets with public access
blocked, the Glue database and three tables, an Athena workgroup with enforced result location, ECR
with scan-on-push, the runtime IAM role, and an optional SageMaker endpoint.

The endpoint defaults to **serverless inference**: no idle cost and no per-instance quota to request
first, which on a new account defaults to zero for every instance type. Setting
`endpoint_instance_type` provisions a dedicated instance instead — `ml.c6i.large` is the cheapest
current-generation x86 option at roughly USD 74 per month. T2 and T3 are not offered for hosting.

The runtime role needs more than read/write on the data bucket: Athena calls `s3:GetBucketLocation`
to verify the workgroup output bucket before running a query and stages results as a multipart
upload, so `ListBucketMultipartUploads` and `ListMultipartUploadParts` are required too. A missing
`GetBucketLocation` surfaces only as `Unable to verify/create output bucket`.

## Teardown

```bash
make destroy CLOUD=aws
```

Terraform reads `force_destroy` from state rather than from the destroy invocation, so the target
applies the flag first and then destroys. Without that, non-empty buckets and an Athena workgroup
holding query history both refuse to delete.

Costs outside the endpoint are per-use: Athena bills per byte scanned with a 10 MB minimum per query,
S3 per stored object. A full verification of this POC — provisioning, seeding, several scoring runs
and dashboard loads — scanned 101 KB across 16 queries and cost well under a cent.
