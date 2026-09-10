from google.cloud import aiplatform_v1
from google.protobuf.json_format import ParseDict
from google.protobuf.struct_pb2 import Value

from credit_policy_studio.config import Settings
from credit_policy_studio.invoker import VertexInvoker
from credit_policy_studio.models import PredictionParameters


class FakePredictionClient:
    def endpoint_path(self, project: str, location: str, endpoint: str) -> str:
        return f"projects/{project}/locations/{location}/endpoints/{endpoint}"

    def predict(self, **kwargs) -> aiplatform_v1.PredictResponse:
        prediction = ParseDict(
            {
                "run_id": "run-1",
                "policy_id": "consumer-credit-poc",
                "policy_version": "Demo",
                "policy_sha256": "abc123",
                "processed_rows": 10,
                "persisted_rows": 10,
                "decisions": {"APPROVED": 7, "REJECTED": 3},
                "started_at": "2026-09-10T00:00:00Z",
                "completed_at": "2026-09-10T00:00:01Z",
                "duration_ms": 1000,
            },
            Value(),
        )
        protobuf_response = aiplatform_v1.PredictResponse.pb()(predictions=[prediction])
        return aiplatform_v1.PredictResponse.wrap(protobuf_response)


def test_vertex_map_composite_prediction_is_decoded() -> None:
    invoker = VertexInvoker(
        Settings(
            gcp_project_id="example",
            gcp_region="us-central1",
            vertex_endpoint_id="credit-policy-scoring",
        ),
        client=FakePredictionClient(),  # type: ignore[arg-type]
    )

    result = invoker.run(PredictionParameters())

    assert result.run_id == "run-1"
    assert result.policy_version == "Demo"
    assert result.decisions == {"APPROVED": 7, "REJECTED": 3}
