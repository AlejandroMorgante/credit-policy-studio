from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

from credit_policy_studio.aws import AthenaWarehouse, S3PolicyRepository, SageMakerInvoker
from credit_policy_studio.config import Settings
from credit_policy_studio.engine import DecisionEngine
from credit_policy_studio.models import CreditPolicy, PredictionParameters
from credit_policy_studio.warehouse import DEMO_APPLICANTS

BUCKET = "credit-policy-test"
POLICY_PATH = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"


def load_policy() -> CreditPolicy:
    return CreditPolicy.model_validate_json(POLICY_PATH.read_text(encoding="utf-8"))


def candidate(policy: CreditPolicy, version: str) -> CreditPolicy:
    payload = policy.model_dump(mode="json")
    payload["metadata"]["version"] = version
    return CreditPolicy.model_validate(payload)


@pytest.fixture
def repository():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        client.put_bucket_versioning(Bucket=BUCKET, VersioningConfiguration={"Status": "Enabled"})
        yield S3PolicyRepository(BUCKET, "policies/active.json", client=client)


def test_publish_activate_and_read_back(repository) -> None:
    policy = load_policy()
    published = repository.publish(policy)
    assert published["version"] == policy.metadata.version

    pointer = repository.activate(policy.metadata.version)
    assert pointer["version"] == policy.metadata.version
    assert pointer["version_id"]

    assert repository.get_active().metadata.version == policy.metadata.version
    assert repository.get_version(policy.metadata.version).metadata.version == (
        policy.metadata.version
    )


def test_publishing_the_same_version_twice_is_rejected(repository) -> None:
    policy = load_policy()
    repository.publish(policy)
    with pytest.raises(FileExistsError):
        repository.publish(policy)


def test_productive_version_is_immutable_but_candidates_are_editable(repository) -> None:
    policy = load_policy()
    repository.publish(policy)
    repository.activate(policy.metadata.version)

    with pytest.raises(PermissionError):
        repository.update(policy)

    draft = candidate(policy, "2026-09-09.2")
    repository.publish(draft)
    edited = draft.model_copy(deep=True)
    edited.nodes[edited.root_node].label = "Edited candidate"
    repository.update(edited)

    assert repository.get_version("2026-09-09.2").nodes[edited.root_node].label == (
        "Edited candidate"
    )
    versions = {item["version"]: item["active"] for item in repository.list_versions()}
    assert versions == {policy.metadata.version: True, "2026-09-09.2": False}


def test_revisions_are_addressable_by_sha(repository) -> None:
    policy = load_policy()
    repository.publish(policy)
    repository.activate(policy.metadata.version)
    draft = candidate(policy, "2026-09-09.2")
    repository.publish(draft)
    original_sha = repository._sha(draft)

    edited = draft.model_copy(deep=True)
    edited.nodes[edited.root_node].label = "Edited candidate"
    repository.update(edited)

    restored = repository.get_revision("2026-09-09.2", original_sha)
    assert restored.nodes[restored.root_node].label == draft.nodes[draft.root_node].label
    with pytest.raises(FileNotFoundError):
        repository.get_revision("2026-09-09.2", "0" * 64)


def test_missing_version_raises_not_found(repository) -> None:
    policy = load_policy()
    repository.publish(policy)
    repository.activate(policy.metadata.version)
    with pytest.raises(FileNotFoundError):
        repository.get_version("does-not-exist")


class StubAthena:
    """Captures submitted queries and replays canned result sets in order."""

    def __init__(self, result_sets: list[list[dict[str, object]]]) -> None:
        self.result_sets = result_sets
        self.calls: list[dict[str, object]] = []

    def start_query_execution(self, **kwargs):
        self.calls.append(kwargs)
        return {"QueryExecutionId": str(len(self.calls) - 1)}

    def get_query_execution(self, QueryExecutionId):  # noqa: N803 - boto3 signature
        return {"QueryExecution": {"Status": {"State": "SUCCEEDED"}}}

    def get_paginator(self, name):
        assert name == "get_query_results"
        outer = self

        class Paginator:
            def paginate(self, QueryExecutionId):  # noqa: N803 - boto3 signature
                rows = outer.result_sets[int(QueryExecutionId)]
                columns = list(rows[0]) if rows else []
                header = [{"Data": [{"VarCharValue": name} for name in columns]}]
                data = [
                    {"Data": [{"VarCharValue": str(row[name])} for name in columns]} for row in rows
                ]
                yield {
                    "ResultSet": {
                        "ResultSetMetadata": {
                            "ColumnInfo": [{"Name": name, "Type": "varchar"} for name in columns]
                        },
                        "Rows": header + data,
                    }
                }

        return Paginator()


def warehouse(result_sets, s3_client=None) -> AthenaWarehouse:
    return AthenaWarehouse(
        database="credit_policy",
        workgroup="credit-policy-studio",
        data_bucket=BUCKET,
        athena_client=StubAthena(result_sets),
        s3_client=s3_client or boto3.client("s3", region_name="us-east-1"),
        poll_seconds=0,
    )


def test_read_applicants_maps_rows_and_clamps_limit() -> None:
    rows = [
        {
            "user_id": "USR-1",
            "score_1": "700",
            "score_2": "80",
            "score_3": "70",
            "variable_1": "5000",
            "variable_2": "900",
            "variable_3": "40",
        }
    ]
    store = warehouse([rows])
    applicants = store.read_applicants(3)

    assert [applicant.user_id for applicant in applicants] == ["USR-1"]
    query = store.athena.calls[0]["QueryString"]
    assert '"credit_policy"."applicants"' in query
    assert "LIMIT 3" in query


def test_list_runs_is_parameterized_and_restores_decisions() -> None:
    rows = [{"run_id": "run-1", "decisions_json": '{"APPROVED": 2}', "processed_rows": "2"}]
    store = warehouse([rows])
    runs = store.list_runs(policy_version="2026-09-09.1", limit=10)

    assert runs[0]["decisions"] == {"APPROVED": 2}
    assert "decisions_json" not in runs[0]
    call = store.athena.calls[0]
    assert call["ExecutionParameters"] == ["2026-09-09.1"]
    assert "policy_version = ?" in call["QueryString"]
    assert "2026-09-09.1" not in call["QueryString"]


def test_dashboard_filters_every_query_by_the_selected_run() -> None:
    latest = [{"run_id": "run-1", "decisions_json": "{}", "completed_at": "2026-09-09T00:00:00Z"}]
    decisions = [{"decision": "APPROVED", "count": "2"}]
    nodes = [{"node_id": "n1", "label": "Root", "count": "2"}]
    paths = [{"source": "n1", "target": "n2", "branch": "true", "count": "2"}]
    store = warehouse([latest, decisions, nodes, paths])

    dashboard = store.dashboard(run_id="run-1")

    assert dashboard["total"] == 2
    assert dashboard["latest_run"]["run_id"] == "run-1"
    assert dashboard["nodes"] == nodes
    for call in store.athena.calls[1:]:
        assert call["ExecutionParameters"] == ["run-1"]
        assert "json_extract_scalar" in call["QueryString"] or "decision" in call["QueryString"]


def test_dashboard_without_runs_returns_the_empty_shape() -> None:
    store = warehouse([[]])
    assert store.dashboard() == {
        "total": 0,
        "decisions": [],
        "nodes": [],
        "paths": [],
        "latest_run": None,
    }


def test_write_results_and_run_land_as_partitioned_ndjson() -> None:
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        store = warehouse([], s3_client=client)
        engine = DecisionEngine(load_policy())
        results = [engine.evaluate(applicant, "run-1") for applicant in DEMO_APPLICANTS[:3]]

        assert store.write_results(results) == 3

        keys = [item["Key"] for item in client.list_objects_v2(Bucket=BUCKET)["Contents"]]
        assert keys and keys[0].startswith("scoring_results/run_id=run-1/")
        body = client.get_object(Bucket=BUCKET, Key=keys[0])["Body"].read().decode()
        rows = [json.loads(line) for line in body.splitlines()]
        assert len(rows) == 3
        assert "trace" not in rows[0]
        assert json.loads(rows[0]["trace_json"])[0]["node_id"]

        summary = engine_summary()
        store.write_run(summary)
        run_body = client.get_object(Bucket=BUCKET, Key="scoring_runs/run-1.json")["Body"].read()
        stored = json.loads(run_body)
        assert stored["decisions_json"] == '{"APPROVED":1}'
        assert "decisions" not in stored


def engine_summary():
    from credit_policy_studio.models import RunSummary

    now = datetime.now(UTC)
    return RunSummary(
        run_id="run-1",
        policy_id="policy",
        policy_version="2026-09-09.1",
        policy_sha256="a" * 64,
        processed_rows=1,
        persisted_rows=1,
        decisions={"APPROVED": 1},
        started_at=now,
        completed_at=now,
        duration_ms=1,
    )


class StubSageMaker:
    def __init__(self, payload: dict) -> None:
        self.payload = payload
        self.calls: list[dict] = []

    def invoke_endpoint(self, **kwargs):
        self.calls.append(kwargs)

        class Body:
            def read(inner) -> bytes:
                return json.dumps(self.payload).encode()

        return {"Body": Body()}


def test_sagemaker_invoker_sends_the_shared_payload_shape() -> None:
    summary = engine_summary()
    client = StubSageMaker({"predictions": [summary.model_dump(mode="json")]})
    settings = Settings(sagemaker_endpoint_name="credit-policy-studio")
    invoker = SageMakerInvoker(settings, client=client)

    result = invoker.run(PredictionParameters(limit=5, policy_version="2026-09-09.1"))

    assert result.run_id == "run-1"
    body = json.loads(client.calls[0]["Body"])
    assert body["instances"] == [{}]
    assert body["parameters"]["limit"] == 5
    assert client.calls[0]["EndpointName"] == "credit-policy-studio"


def test_sagemaker_invoker_rejects_an_empty_response() -> None:
    client = StubSageMaker({"predictions": []})
    invoker = SageMakerInvoker(Settings(sagemaker_endpoint_name="e"), client=client)
    with pytest.raises(RuntimeError):
        invoker.run(PredictionParameters())
