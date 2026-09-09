from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "local"
    cloud_provider: str = "local"
    gcp_project_id: str = ""
    gcp_region: str = "us-central1"
    bigquery_location: str = "US"
    bigquery_dataset: str = "credit_policy"
    bigquery_input_table: str = "applicants"
    bigquery_output_table: str = "scoring_results"
    bigquery_runs_table: str = "scoring_runs"
    policy_bucket: str = ""
    policy_active_object: str = "policies/active.json"
    local_policy_path: Path = Path("policies/credit_policy_v1.json")
    vertex_endpoint_id: str = ""
    aws_region: str = "us-east-1"
    data_bucket: str = ""
    glue_database: str = "credit_policy"
    athena_workgroup: str = "credit-policy-studio"
    athena_output_uri: str = ""
    sagemaker_endpoint_name: str = ""
    max_batch_size: int = Field(default=1000, ge=1, le=10000)

    @property
    def provider(self) -> str:
        """Selected cloud adapter set; app_env stays the local-development switch."""
        if self.app_env == "local":
            return "local"
        return self.cloud_provider if self.cloud_provider != "local" else "gcp"

    @property
    def input_table_fqn(self) -> str:
        return f"{self.gcp_project_id}.{self.bigquery_dataset}.{self.bigquery_input_table}"

    @property
    def output_table_fqn(self) -> str:
        return f"{self.gcp_project_id}.{self.bigquery_dataset}.{self.bigquery_output_table}"

    @property
    def runs_table_fqn(self) -> str:
        return f"{self.gcp_project_id}.{self.bigquery_dataset}.{self.bigquery_runs_table}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
