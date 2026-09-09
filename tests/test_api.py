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
