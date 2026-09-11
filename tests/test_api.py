import pytest
from fastapi.testclient import TestClient

from credit_policy_studio.api import app
from credit_policy_studio.dependencies import (
    get_policy_repository,
    get_scoring_service,
    get_warehouse,
)
from credit_policy_studio.models import PredictionParameters
from credit_policy_studio.repositories import LocalPolicyRepository
from credit_policy_studio.service import ScoringService
from credit_policy_studio.warehouse import MemoryWarehouse


def test_vertex_prediction_contract(tmp_path) -> None:
    from pathlib import Path

    policy = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"
    warehouse = MemoryWarehouse()
    policies = LocalPolicyRepository(policy)
    app.dependency_overrides[get_policy_repository] = lambda: policies
    app.dependency_overrides[get_warehouse] = lambda: warehouse
    app.dependency_overrides[get_scoring_service] = lambda: ScoringService(policies, warehouse)

    try:
        response = TestClient(app).post(
            "/predict",
            json={"instances": [{}], "parameters": {"limit": 3}},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    prediction = response.json()["predictions"][0]
    assert prediction["processed_rows"] == 3
    assert prediction["persisted_rows"] == 3
    assert prediction["policy_version"] == "2026-09-09.1"


def test_candidate_version_can_be_evaluated_without_changing_production(
    tmp_path, monkeypatch
) -> None:
    from pathlib import Path

    monkeypatch.chdir(tmp_path)
    source = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"
    policies = LocalPolicyRepository(source)
    candidate = policies.get_active().model_copy(deep=True)
    candidate.metadata.version = "2026-09-09.2"
    candidate.metadata.status = "draft"
    candidate.nodes["bureau-floor"].value = 900
    policies.publish(candidate)

    assert policies.get_active().metadata.version == "2026-09-09.1"
    assert policies.get_version("2026-09-09.2").nodes["bureau-floor"].value == 900
    assert {item["version"] for item in policies.list_versions()} == {
        "2026-09-09.1",
        "2026-09-09.2",
    }

    warehouse = MemoryWarehouse()
    result = ScoringService(policies, warehouse).run(
        PredictionParameters(limit=3, run_id="candidate-run", policy_version="2026-09-09.2")
    )

    assert result.policy_version == "2026-09-09.2"
    assert warehouse.dashboard(run_id="candidate-run")["total"] == 3
    candidate.nodes["bureau-floor"].value = 800
    policies.update(candidate)
    assert policies.get_version("2026-09-09.2").nodes["bureau-floor"].value == 800
    assert (
        policies.get_revision("2026-09-09.2", result.policy_sha256).nodes["bureau-floor"].value
        == 900
    )
    policies.activate("2026-09-09.2")
    assert policies.get_active().metadata.version == "2026-09-09.2"
    assert LocalPolicyRepository(source).get_active().metadata.version == "2026-09-09.2"


def test_dashboard_uses_one_run_instead_of_accumulating() -> None:
    from pathlib import Path

    policies = LocalPolicyRepository(
        Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"
    )
    warehouse = MemoryWarehouse()
    service = ScoringService(policies, warehouse)
    service.run(PredictionParameters(limit=2, run_id="run-small"))
    service.run(PredictionParameters(limit=5, run_id="run-large"))

    assert warehouse.dashboard(run_id="run-small")["total"] == 2
    assert warehouse.dashboard(run_id="run-large")["total"] == 5
    assert warehouse.dashboard()["total"] == 5
    assert [run["run_id"] for run in warehouse.list_runs("2026-09-09.1")] == [
        "run-large",
        "run-small",
    ]


def test_productive_policy_cannot_be_updated_through_api(tmp_path, monkeypatch) -> None:
    from pathlib import Path

    monkeypatch.chdir(tmp_path)
    source = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"
    policies = LocalPolicyRepository(source)
    policy = policies.get_active()
    policy.nodes["bureau-floor"].value = 999
    app.dependency_overrides[get_policy_repository] = lambda: policies

    try:
        response = TestClient(app).put(
            f"/api/policies/{policy.metadata.version}",
            json={"policy": policy.model_dump(mode="json")},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 409
    assert policies.get_active().nodes["bureau-floor"].value != 999


def test_duplicate_policy_version_returns_conflict(tmp_path, monkeypatch) -> None:
    from pathlib import Path

    monkeypatch.chdir(tmp_path)
    source = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"
    policies = LocalPolicyRepository(source)
    policy = policies.get_active()
    app.dependency_overrides[get_policy_repository] = lambda: policies

    try:
        response = TestClient(app).post(
            "/api/policies/publish",
            json={"policy": policy.model_dump(mode="json")},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 409


def test_combined_candidate_save_evaluate_history_and_promotion(tmp_path, monkeypatch) -> None:
    from pathlib import Path

    from credit_policy_studio.models import Applicant
    from credit_policy_studio.warehouse import DEMO_APPLICANTS

    monkeypatch.chdir(tmp_path)
    source = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"
    policies = LocalPolicyRepository(source)
    active = policies.get_active()
    payload = active.model_dump(mode="json")
    payload["metadata"].update(version="combined-candidate", status="draft")
    node = payload["nodes"][active.root_node]
    for key in ("field", "operator", "value"):
        del node[key]
    node.update(
        combination="AND",
        validations=[
            {"field": "score_1", "operator": "has_value", "value": True},
            {"field": "score_1", "operator": "gt", "value": 650},
        ],
    )
    warehouse = MemoryWarehouse([DEMO_APPLICANTS[0], Applicant(user_id="missing-score")])
    app.dependency_overrides[get_policy_repository] = lambda: policies
    app.dependency_overrides[get_warehouse] = lambda: warehouse
    app.dependency_overrides[get_scoring_service] = lambda: ScoringService(policies, warehouse)
    client = TestClient(app)
    url = "/api/policies/combined-candidate"
    try:
        assert client.post("/api/policies/publish", json={"policy": payload}).status_code == 200
        assert client.get(url).json()["nodes"][active.root_node] == node
        assert client.post("/api/policies/validate", json={"policy": payload}).status_code == 200
        result = client.post(
            "/predict",
            json={"parameters": {"policy_version": "combined-candidate", "limit": 2}},
        )
        assert result.status_code == 200
        run = result.json()["predictions"][0]
        assert run["decisions"] == {"APPROVED": 1, "REJECTED": 1}
        dashboard = client.get("/api/dashboard", params={"run_id": run["run_id"]}).json()
        root = next(item for item in dashboard["nodes"] if item["node_id"] == active.root_node)
        assert root["count"] == 2
        node["combination"] = "OR"
        assert client.put(url, json={"policy": payload}).status_code == 200
        historical = client.get(url, params={"policy_sha256": run["policy_sha256"]}).json()
        assert historical["nodes"][active.root_node]["combination"] == "AND"
        assert client.get("/api/policy").json() == active.model_dump(mode="json")
        node["combination"] = "none"
        assert client.put(url, json={"policy": payload}).status_code == 422
        assert client.get(url).json()["nodes"][active.root_node]["combination"] == "OR"
        node["combination"] = "OR"
        assert client.post(f"{url}/activate").status_code == 200
        node["validations"][1]["value"] = 999
        assert client.put(url, json={"policy": payload}).status_code == 409
        assert (
            client.get("/api/policy").json()["nodes"][active.root_node]["validations"][1]["value"]
            == 650
        )
    finally:
        app.dependency_overrides.clear()


def test_sagemaker_invocations_route_shares_the_predict_contract() -> None:
    from pathlib import Path

    policy = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"
    warehouse = MemoryWarehouse()
    policies = LocalPolicyRepository(policy)
    app.dependency_overrides[get_scoring_service] = lambda: ScoringService(policies, warehouse)

    try:
        response = TestClient(app).post(
            "/invocations",
            json={"instances": [{}], "parameters": {"limit": 2}},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["predictions"][0]["processed_rows"] == 2


@pytest.mark.parametrize("invalid_edit", ["pending", "missing", "cycle", "detached", "deleted"])
def test_structural_edits_are_validated_and_preserve_saved_revisions(
    tmp_path, monkeypatch, invalid_edit
) -> None:
    from copy import deepcopy
    from pathlib import Path

    from credit_policy_studio.engine import DecisionEngine, policy_sha256
    from credit_policy_studio.models import CreditPolicy
    from credit_policy_studio.warehouse import DEMO_APPLICANTS

    monkeypatch.chdir(tmp_path)
    source = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"
    repository = LocalPolicyRepository(source)
    active = repository.get_active()
    payload = active.model_dump(mode="json")
    payload["metadata"].update(version="structural-candidate", status="draft")
    candidate = CreditPolicy.model_validate(payload)
    repository.publish(candidate)
    before_hash = policy_sha256(candidate)
    old_root = payload["root_node"]
    payload["nodes"]["new-entry"] = {
        "id": "new-entry",
        "type": "condition",
        "label": "New entry",
        "combination": "none",
        "validations": [{"field": "score_1", "operator": "has_value", "value": True}],
        "true_node": old_root,
        "false_node": "reject-bureau",
    }
    payload["root_node"] = "new-entry"
    url = "/api/policies/structural-candidate"
    app.dependency_overrides[get_policy_repository] = lambda: repository
    try:
        client = TestClient(app)
        assert client.put(url, json={"policy": payload}).status_code == 200
        saved = client.get(url).json()
        assert saved["root_node"] == "new-entry"
        historical = client.get(url, params={"policy_sha256": before_hash}).json()
        assert historical == candidate.model_dump(mode="json")
        engine = DecisionEngine(CreditPolicy.model_validate(saved))
        result = engine.evaluate(DEMO_APPLICANTS[0], "structural-check")
        assert [step.node_id for step in result.trace][:2] == ["new-entry", old_root]

        invalid = deepcopy(payload)
        if invalid_edit == "detached":
            invalid["root_node"] = old_root
            # Historical reads remain compatible; new writes require every module to be reachable.
            assert CreditPolicy.model_validate(invalid).root_node == old_root
        elif invalid_edit == "deleted":
            del invalid["nodes"][old_root]
        else:
            invalid["nodes"]["new-entry"]["true_node"] = {
                "pending": None,
                "missing": "nonexistent",
                "cycle": "new-entry",
            }[invalid_edit]
        assert client.post("/api/policies/validate", json={"policy": invalid}).status_code == 422
        assert client.put(url, json={"policy": invalid}).status_code == 422
        assert client.get(url).json() == saved

        # Productive policies reject valid structural modifications as well.
        payload["metadata"] = active.metadata.model_dump(mode="json")
        assert (
            client.put(
                f"/api/policies/{active.metadata.version}", json={"policy": payload}
            ).status_code
            == 409
        )
        assert repository.get_active() == active
    finally:
        app.dependency_overrides.clear()


def test_configured_endpoint_is_used_instead_of_the_in_process_engine() -> None:
    from pathlib import Path

    from credit_policy_studio.dependencies import get_remote_invoker
    from credit_policy_studio.models import RunSummary

    policy = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"
    policies = LocalPolicyRepository(policy)
    warehouse = MemoryWarehouse()
    calls: list[PredictionParameters] = []

    class StubInvoker:
        def run(self, parameters: PredictionParameters) -> RunSummary:
            calls.append(parameters)
            summary = ScoringService(policies, warehouse).run(parameters)
            return summary.model_copy(update={"policy_id": "from-endpoint"})

    app.dependency_overrides[get_scoring_service] = lambda: ScoringService(policies, warehouse)
    app.dependency_overrides[get_remote_invoker] = StubInvoker

    try:
        response = TestClient(app).post(
            "/api/runs",
            json={"instances": [{}], "parameters": {"limit": 4}},
        )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    assert response.json()["policy_id"] == "from-endpoint"
    assert [parameters.limit for parameters in calls] == [4]
