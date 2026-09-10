from __future__ import annotations

from typing import Any, Protocol

from .config import Settings
from .models import PredictionParameters, RunSummary


class RemoteInvoker(Protocol):
    """A deployed scoring endpoint that turns parameters into one auditable run."""

    def run(self, parameters: PredictionParameters) -> RunSummary: ...


class VertexInvoker:
    def __init__(
        self,
        settings: Settings,
        client: Any | None = None,
    ) -> None:
        # Imported here so the AWS path never loads the Google Cloud SDK.
        from google.api_core.client_options import ClientOptions
        from google.cloud import aiplatform_v1

        self.settings = settings
        self.client = client or aiplatform_v1.PredictionServiceClient(
            client_options=ClientOptions(
                api_endpoint=f"{settings.gcp_region}-aiplatform.googleapis.com"
            )
        )

    def run(self, parameters: PredictionParameters) -> RunSummary:
        from google.cloud import aiplatform_v1
        from google.protobuf.json_format import ParseDict
        from google.protobuf.struct_pb2 import Value

        endpoint = self.settings.vertex_endpoint_id
        if not endpoint.startswith("projects/"):
            endpoint = self.client.endpoint_path(
                project=self.settings.gcp_project_id,
                location=self.settings.gcp_region,
                endpoint=endpoint,
            )
        instance = ParseDict({}, Value())
        parameter_value = ParseDict(parameters.model_dump(mode="json"), Value())
        response = self.client.predict(
            endpoint=endpoint,
            instances=[instance],
            parameters=parameter_value,
        )
        if not response.predictions:
            raise RuntimeError("Vertex returned no predictions")
        payload = aiplatform_v1.PredictResponse.to_dict(response)["predictions"][0]
        return RunSummary.model_validate(payload)
