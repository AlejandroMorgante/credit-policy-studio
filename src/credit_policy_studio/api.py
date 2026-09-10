from __future__ import annotations

from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google.api_core.exceptions import PreconditionFailed

from . import __version__
from .config import Settings, get_settings
from .dependencies import get_policy_repository, get_scoring_service, get_warehouse
from .invoker import VertexInvoker
from .models import CreditPolicy, PublishPolicyRequest, RunSummary, VertexPredictionRequest
from .repositories import PolicyRepository
from .service import ScoringService
from .warehouse import Warehouse

app = FastAPI(
    title="Credit Policy Studio",
    version=__version__,
    description="Versioned credit decision policies for Vertex AI and BigQuery.",
)

ScoringServiceDep = Annotated[ScoringService, Depends(get_scoring_service)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
PolicyRepositoryDep = Annotated[PolicyRepository, Depends(get_policy_repository)]
WarehouseDep = Annotated[Warehouse, Depends(get_warehouse)]

WEB_DIR = Path(__file__).resolve().parents[2] / "web"
if WEB_DIR.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIR), name="assets")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/health")
@app.get("/ping", include_in_schema=False)
def health() -> dict[str, str]:
    return {"status": "healthy", "version": __version__}


@app.post("/predict", response_model=dict[str, list[RunSummary]])
def predict(
    request: VertexPredictionRequest,
    service: ScoringServiceDep,
) -> dict[str, list[RunSummary]]:
    # Vertex requires an instances array even though rows are sourced from BigQuery.
    # One request intentionally produces one auditable batch run.
    _ = request.instances
    return {"predictions": [service.run(request.parameters)]}


@app.post("/api/runs", response_model=RunSummary)
def create_run(
    request: VertexPredictionRequest,
    service: ScoringServiceDep,
    settings: SettingsDep,
) -> RunSummary:
    # The localhost POC becomes a thin authenticated facade when an endpoint is configured.
    # With no endpoint it falls back to the in-memory demo for contributors and CI.
    if settings.vertex_endpoint_id:
        return VertexInvoker(settings).run(request.parameters)
    return service.run(request.parameters)


@app.get("/api/runs")
def list_runs(
    warehouse: WarehouseDep,
    policy_version: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[dict]:
    return warehouse.list_runs(policy_version, limit)


@app.get("/api/policy", response_model=CreditPolicy)
def active_policy(repository: PolicyRepositoryDep) -> CreditPolicy:
    return repository.get_active()


@app.get("/api/policies")
def policy_versions(repository: PolicyRepositoryDep) -> list[dict[str, str | bool]]:
    return repository.list_versions()


@app.get("/api/policies/{version}", response_model=CreditPolicy)
def policy_version(
    version: str,
    repository: PolicyRepositoryDep,
    policy_sha256: Annotated[str | None, Query()] = None,
) -> CreditPolicy:
    try:
        return (
            repository.get_revision(version, policy_sha256)
            if policy_sha256
            else repository.get_version(version)
        )
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.post("/api/policies/{version}/activate")
def activate_policy(version: str, repository: PolicyRepositoryDep) -> dict[str, str | int]:
    try:
        return repository.activate(version)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@app.put("/api/policies/{version}")
def update_policy(
    version: str,
    request: PublishPolicyRequest,
    repository: PolicyRepositoryDep,
) -> dict[str, str | int]:
    if request.policy.metadata.version != version:
        raise HTTPException(status_code=400, detail="Path and policy versions do not match")
    try:
        return repository.update(request.policy)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.post("/api/policies/validate")
def validate_policy(request: PublishPolicyRequest) -> dict[str, str | int]:
    return {
        "status": "valid",
        "policy_id": request.policy.metadata.policy_id,
        "version": request.policy.metadata.version,
        "nodes": len(request.policy.nodes),
    }


@app.post("/api/policies/publish")
def publish_policy(
    request: PublishPolicyRequest,
    repository: PolicyRepositoryDep,
) -> dict[str, str | int]:
    try:
        return repository.publish(request.policy)
    except (FileExistsError, PreconditionFailed) as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@app.get("/api/dashboard")
def dashboard(
    warehouse: WarehouseDep,
    policy_version: Annotated[str | None, Query()] = None,
    run_id: Annotated[str | None, Query()] = None,
) -> dict:
    return warehouse.dashboard(policy_version, run_id)
