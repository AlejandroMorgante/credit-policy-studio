from functools import lru_cache

from .config import get_settings
from .repositories import GcsPolicyRepository, LocalPolicyRepository, PolicyRepository
from .service import ScoringService
from .warehouse import BigQueryWarehouse, MemoryWarehouse, Warehouse


@lru_cache
def get_policy_repository() -> PolicyRepository:
    settings = get_settings()
    if settings.app_env == "local":
        return LocalPolicyRepository(settings.local_policy_path)
    if not settings.gcp_project_id or not settings.policy_bucket:
        raise RuntimeError("GCP_PROJECT_ID and POLICY_BUCKET are required outside local mode")
    return GcsPolicyRepository(
        project_id=settings.gcp_project_id,
        bucket_name=settings.policy_bucket,
        active_object=settings.policy_active_object,
    )


@lru_cache
def get_warehouse() -> Warehouse:
    settings = get_settings()
    if settings.app_env == "local":
        return MemoryWarehouse()
    if not settings.gcp_project_id:
        raise RuntimeError("GCP_PROJECT_ID is required outside local mode")
    return BigQueryWarehouse(
        project_id=settings.gcp_project_id,
        location=settings.bigquery_location,
        input_table=settings.input_table_fqn,
        output_table=settings.output_table_fqn,
        runs_table=settings.runs_table_fqn,
    )


def get_scoring_service() -> ScoringService:
    return ScoringService(get_policy_repository(), get_warehouse())
