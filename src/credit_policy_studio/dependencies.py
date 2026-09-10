from functools import lru_cache

from .config import get_settings
from .invoker import RemoteInvoker
from .repositories import GcsPolicyRepository, LocalPolicyRepository, PolicyRepository
from .service import ScoringService
from .warehouse import BigQueryWarehouse, MemoryWarehouse, Warehouse


@lru_cache
def get_policy_repository() -> PolicyRepository:
    settings = get_settings()
    provider = settings.provider
    if provider == "local":
        return LocalPolicyRepository(settings.local_policy_path)
    if not settings.policy_bucket:
        raise RuntimeError("POLICY_BUCKET is required outside local mode")
    if provider == "aws":
        from .aws import S3PolicyRepository

        return S3PolicyRepository(
            bucket_name=settings.policy_bucket,
            active_object=settings.policy_active_object,
            region=settings.aws_region,
        )
    if not settings.gcp_project_id:
        raise RuntimeError("GCP_PROJECT_ID and POLICY_BUCKET are required outside local mode")
    return GcsPolicyRepository(
        project_id=settings.gcp_project_id,
        bucket_name=settings.policy_bucket,
        active_object=settings.policy_active_object,
    )


@lru_cache
def get_warehouse() -> Warehouse:
    settings = get_settings()
    provider = settings.provider
    if provider == "local":
        return MemoryWarehouse()
    if provider == "aws":
        if not settings.data_bucket:
            raise RuntimeError("DATA_BUCKET is required for the AWS provider")
        from .aws import AthenaWarehouse

        return AthenaWarehouse(
            database=settings.glue_database,
            workgroup=settings.athena_workgroup,
            data_bucket=settings.data_bucket,
            output_uri=settings.athena_output_uri,
            input_table=settings.bigquery_input_table,
            output_table=settings.bigquery_output_table,
            runs_table=settings.bigquery_runs_table,
            region=settings.aws_region,
        )
    if not settings.gcp_project_id:
        raise RuntimeError("GCP_PROJECT_ID is required outside local mode")
    return BigQueryWarehouse(
        project_id=settings.gcp_project_id,
        location=settings.bigquery_location,
        input_table=settings.input_table_fqn,
        output_table=settings.output_table_fqn,
        runs_table=settings.runs_table_fqn,
    )


def get_remote_invoker() -> RemoteInvoker | None:
    """Returns the endpoint invoker for the active provider, or None to run in-process."""
    settings = get_settings()
    if settings.provider == "aws" and settings.sagemaker_endpoint_name:
        from .aws import SageMakerInvoker

        return SageMakerInvoker(settings)
    if settings.provider == "gcp" and settings.vertex_endpoint_id:
        from .invoker import VertexInvoker

        return VertexInvoker(settings)
    return None


def get_scoring_service() -> ScoringService:
    return ScoringService(get_policy_repository(), get_warehouse())
