import json
from datetime import UTC, datetime
from typing import Any

from credit_policy_studio.models import RunSummary
from credit_policy_studio.warehouse import BigQueryWarehouse


class RecordingBigQueryClient:
    def __init__(self) -> None:
        self.table = ""
        self.rows: list[dict[str, Any]] = []

    def insert_rows_json(self, table: str, rows: list[dict[str, Any]]) -> list:
        self.table = table
        self.rows = rows
        return []


def test_run_decisions_are_serialized_for_bigquery_json_column() -> None:
    client = RecordingBigQueryClient()
    warehouse = BigQueryWarehouse(
        project_id="example",
        location="US",
        input_table="example.dataset.input",
        output_table="example.dataset.output",
        runs_table="example.dataset.runs",
        client=client,  # type: ignore[arg-type]
    )
    timestamp = datetime.now(UTC)
    summary = RunSummary(
        run_id="run-1",
        policy_id="credit-policy",
        policy_version="v1",
        policy_sha256="abc123",
        processed_rows=10,
        persisted_rows=10,
        decisions={"APPROVED": 7, "REJECTED": 3},
        started_at=timestamp,
        completed_at=timestamp,
        duration_ms=20,
    )

    warehouse.write_run(summary)

    assert client.table == "example.dataset.runs"
    assert isinstance(client.rows[0]["decisions"], str)
    assert json.loads(client.rows[0]["decisions"]) == {"APPROVED": 7, "REJECTED": 3}
