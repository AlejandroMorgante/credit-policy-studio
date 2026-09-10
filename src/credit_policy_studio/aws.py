"""AWS adapters: S3 policies, Athena warehouse, SageMaker invocation.

Kept in a single module so the AWS SDK is imported only when CLOUD_PROVIDER=aws.
The GCP adapters in `repositories.py`, `warehouse.py` and `invoker.py` are unaffected.
"""

from __future__ import annotations

import json
import time
from typing import Any
from uuid import uuid4

import boto3
from botocore.exceptions import ClientError

from .config import Settings
from .models import Applicant, PredictionParameters, RunSummary, ScoringResult
from .repositories import ObjectPolicyRepository

_CREATE_ONLY = "*"
_MISSING = {"NoSuchKey", "404", "NoSuchVersion"}
_CONFLICT = {"PreconditionFailed", "ConditionalRequestConflict"}


def _code(error: ClientError) -> str:
    return str(error.response.get("Error", {}).get("Code", ""))


class S3ObjectStore:
    """S3 object store; version ids are the version tokens.

    Object generations map to S3 version ids, and generation preconditions map to
    S3 conditional writes (IfNoneMatch for create-only, IfMatch for replace).
    """

    def __init__(
        self,
        bucket_name: str,
        region: str = "us-east-1",
        client: Any | None = None,
    ) -> None:
        self.bucket_name = bucket_name
        self.client = client or boto3.client("s3", region_name=region)

    def _put(self, key: str, payload: str, **conditions: str) -> str:
        response = self.client.put_object(
            Bucket=self.bucket_name,
            Key=key,
            Body=payload.encode("utf-8"),
            ContentType="application/json",
            **conditions,
        )
        return str(response.get("VersionId", ""))

    def read(self, key: str, version: str | int | None = None) -> str:
        kwargs: dict[str, Any] = {"Bucket": self.bucket_name, "Key": key}
        if version:
            kwargs["VersionId"] = str(version)
        try:
            return self.client.get_object(**kwargs)["Body"].read().decode("utf-8")
        except ClientError as error:
            if _code(error) in _MISSING:
                raise FileNotFoundError(f"Object {key!r} does not exist") from error
            raise

    def create(self, key: str, payload: str) -> str:
        try:
            return self._put(key, payload, IfNoneMatch=_CREATE_ONLY)
        except ClientError as error:
            if _code(error) in _CONFLICT:
                raise FileExistsError(f"Object {key!r} already exists") from error
            raise

    def replace(self, key: str, payload: str) -> str:
        try:
            head = self.client.head_object(Bucket=self.bucket_name, Key=key)
        except ClientError as error:
            if _code(error) in _MISSING:
                raise FileNotFoundError(f"Object {key!r} does not exist") from error
            raise
        return self._put(key, payload, IfMatch=head["ETag"])

    def put(self, key: str, payload: str) -> str:
        return self._put(key, payload)

    def version_of(self, key: str) -> str:
        try:
            head = self.client.head_object(Bucket=self.bucket_name, Key=key)
        except ClientError as error:
            if _code(error) in _MISSING:
                raise FileNotFoundError(f"Object {key!r} does not exist") from error
            raise
        return str(head.get("VersionId", ""))

    def list_direct(self, prefix: str) -> list[str]:
        keys: list[str] = []
        prefixes: list[str] = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket_name, Prefix=prefix, Delimiter="/"):
            keys.extend(item["Key"] for item in page.get("Contents", []))
            prefixes.extend(item["Prefix"] for item in page.get("CommonPrefixes", []))
        return keys + prefixes


class S3PolicyRepository(ObjectPolicyRepository):
    def __init__(
        self,
        bucket_name: str,
        active_object: str,
        region: str = "us-east-1",
        client: Any | None = None,
    ) -> None:
        super().__init__(S3ObjectStore(bucket_name, region, client), active_object)


def _literal(value: str) -> str:
    """Quote and escape a string for Athena's ExecutionParameters.

    Athena substitutes execution parameters as SQL literal text rather than
    binding them as typed values, so an unquoted string is parsed as SQL. A
    policy version like 2026-09-09.1 reads as a number and the query fails with
    "TYPE_MISMATCH: Cannot apply operator: varchar = double". Doubling any
    embedded quote keeps the literal well formed.
    """
    return "'" + value.replace("'", "''") + "'"


_TERMINAL = {"SUCCEEDED", "FAILED", "CANCELLED"}
_INT_TYPES = {"bigint", "integer", "smallint", "tinyint"}
_FLOAT_TYPES = {"double", "float", "real", "decimal"}


def _cast(value: str | None, column_type: str) -> Any:
    if value is None:
        return None
    if column_type in _INT_TYPES:
        return int(value)
    if column_type in _FLOAT_TYPES:
        return float(value)
    if column_type == "boolean":
        return value == "true"
    return value


class AthenaWarehouse:
    """Athena over external tables on S3, replacing BigQuery.

    Writes are plain objects: one newline-delimited JSON file per run. This avoids DML,
    the Athena query-size limit on large trace payloads, and table maintenance.
    ponytail: one small object per run; move to an Iceberg table with periodic
    compaction if run volume makes small-file scans slow.
    """

    def __init__(
        self,
        database: str,
        workgroup: str,
        data_bucket: str,
        output_uri: str = "",
        input_table: str = "applicants",
        output_table: str = "scoring_results",
        runs_table: str = "scoring_runs",
        region: str = "us-east-1",
        athena_client: Any | None = None,
        s3_client: Any | None = None,
        poll_seconds: float = 0.5,
    ) -> None:
        self.database = database
        self.workgroup = workgroup
        self.data_bucket = data_bucket
        self.output_uri = output_uri
        self.input_table = input_table
        self.output_table = output_table
        self.runs_table = runs_table
        self.poll_seconds = poll_seconds
        self.athena = athena_client or boto3.client("athena", region_name=region)
        self.s3 = s3_client or boto3.client("s3", region_name=region)

    def _table(self, name: str) -> str:
        return f'"{self.database}"."{name}"'

    def _query(self, sql: str, parameters: list[str] | None = None) -> list[dict[str, Any]]:
        request: dict[str, Any] = {
            "QueryString": sql,
            "QueryExecutionContext": {"Database": self.database},
            "WorkGroup": self.workgroup,
        }
        if self.output_uri:
            request["ResultConfiguration"] = {"OutputLocation": self.output_uri}
        if parameters:
            request["ExecutionParameters"] = parameters
        execution_id = self.athena.start_query_execution(**request)["QueryExecutionId"]
        while True:
            execution = self.athena.get_query_execution(QueryExecutionId=execution_id)
            status = execution["QueryExecution"]["Status"]
            if status["State"] in _TERMINAL:
                break
            time.sleep(self.poll_seconds)
        if status["State"] != "SUCCEEDED":
            raise RuntimeError(
                f"Athena query {status['State']}: {status.get('StateChangeReason', '')}"
            )
        return self._rows(execution_id)

    def _rows(self, execution_id: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        columns: list[tuple[str, str]] = []
        paginator = self.athena.get_paginator("get_query_results")
        for index, page in enumerate(paginator.paginate(QueryExecutionId=execution_id)):
            result_set = page["ResultSet"]
            if not columns:
                columns = [
                    (column["Name"], column["Type"])
                    for column in result_set["ResultSetMetadata"]["ColumnInfo"]
                ]
            # Athena repeats the header as the first row of the first page only.
            data = result_set["Rows"][1:] if index == 0 else result_set["Rows"]
            for row in data:
                values = [item.get("VarCharValue") for item in row["Data"]]
                rows.append(
                    {
                        name: _cast(value, column_type)
                        for (name, column_type), value in zip(columns, values, strict=False)
                    }
                )
        return rows

    def _put(self, key: str, lines: list[dict[str, Any]]) -> None:
        body = "\n".join(json.dumps(line, separators=(",", ":")) for line in lines)
        self.s3.put_object(
            Bucket=self.data_bucket,
            Key=key,
            Body=body.encode("utf-8"),
            ContentType="application/x-ndjson",
        )

    def read_applicants(self, limit: int) -> list[Applicant]:
        # limit is already validated by PredictionParameters; Athena rejects a
        # parameter placeholder in LIMIT, so it is interpolated as an integer.
        query = f"""
            SELECT user_id, score_1, score_2, score_3, variable_1, variable_2, variable_3
            FROM {self._table(self.input_table)}
            ORDER BY user_id
            LIMIT {int(limit)}
        """
        return [Applicant.model_validate(row) for row in self._query(query)]

    def write_results(self, results: list[ScoringResult]) -> int:
        if not results:
            return 0
        payload = []
        for result in results:
            row = result.model_dump(mode="json", exclude={"trace"})
            row["trace_json"] = json.dumps(
                [step.model_dump(mode="json") for step in result.trace], separators=(",", ":")
            )
            payload.append(row)
        run_id = results[0].run_id
        self._put(f"{self.output_table}/run_id={run_id}/{uuid4()}.json", payload)
        return len(payload)

    def write_run(self, summary: RunSummary) -> None:
        row = summary.model_dump(mode="json", exclude={"decisions"})
        row["decisions_json"] = json.dumps(summary.decisions, separators=(",", ":"))
        self._put(f"{self.runs_table}/{summary.run_id}.json", [row])

    @staticmethod
    def _run_row(row: dict[str, Any]) -> dict[str, Any]:
        run = dict(row)
        run["decisions"] = json.loads(run.pop("decisions_json", None) or "{}")
        return run

    def list_runs(self, policy_version: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        parameters = [_literal(policy_version)] if policy_version else []
        where = "WHERE policy_version = ?" if policy_version else ""
        query = f"""
            SELECT run_id, policy_id, policy_version, policy_sha256, processed_rows,
                   persisted_rows, decisions_json, started_at, completed_at, duration_ms
            FROM {self._table(self.runs_table)}
            {where}
            ORDER BY from_iso8601_timestamp(completed_at) DESC
            LIMIT {int(limit)}
        """
        return [self._run_row(row) for row in self._query(query, parameters)]

    def dashboard(
        self, policy_version: str | None = None, run_id: str | None = None
    ) -> dict[str, Any]:
        filters = []
        parameters = []
        if policy_version:
            filters.append("policy_version = ?")
            parameters.append(_literal(policy_version))
        if run_id:
            filters.append("run_id = ?")
            parameters.append(_literal(run_id))
        where = f"WHERE {' AND '.join(filters)}" if filters else ""
        latest_query = f"""
            SELECT run_id, policy_id, policy_version, policy_sha256, processed_rows,
                   persisted_rows, decisions_json, started_at, completed_at, duration_ms
            FROM {self._table(self.runs_table)}
            {where}
            ORDER BY from_iso8601_timestamp(completed_at) DESC
            LIMIT 1
        """
        latest_rows = self._query(latest_query, parameters)
        if not latest_rows:
            return {"total": 0, "decisions": [], "nodes": [], "paths": [], "latest_run": None}
        latest_run = self._run_row(latest_rows[0])
        selected = [_literal(str(latest_run["run_id"]))]
        results = self._table(self.output_table)
        decision_query = f"""
            SELECT decision, COUNT(*) AS count
            FROM {results}
            WHERE run_id = ?
            GROUP BY decision ORDER BY count DESC
        """
        node_query = f"""
            WITH filtered AS (
              SELECT leaf_node_id, decision, trace_json FROM {results} WHERE run_id = ?
            ), visited AS (
              SELECT json_extract_scalar(step, '$.node_id') AS node_id,
                     json_extract_scalar(step, '$.label') AS label
              FROM filtered
              CROSS JOIN UNNEST(CAST(json_parse(trace_json) AS array(json))) AS t(step)
              UNION ALL
              SELECT leaf_node_id, decision FROM filtered
            )
            SELECT node_id, arbitrary(label) AS label, COUNT(*) AS count
            FROM visited GROUP BY node_id ORDER BY count DESC
        """
        path_query = f"""
            SELECT json_extract_scalar(step, '$.node_id') AS source,
                   json_extract_scalar(step, '$.next_node') AS target,
                   json_extract_scalar(step, '$.branch') = 'true' AS branch,
                   COUNT(*) AS count
            FROM {results}
            CROSS JOIN UNNEST(CAST(json_parse(trace_json) AS array(json))) AS t(step)
            WHERE run_id = ?
            GROUP BY 1, 2, 3 ORDER BY count DESC
        """
        decision_rows = self._query(decision_query, selected)
        node_rows = self._query(node_query, selected)
        path_rows = self._query(path_query, selected)
        return {
            "total": sum(int(row["count"]) for row in decision_rows),
            "decisions": decision_rows,
            "nodes": node_rows,
            "paths": path_rows,
            "latest_run": latest_run,
        }


class SageMakerInvoker:
    """Invokes the scoring container hosted on a SageMaker real-time endpoint."""

    def __init__(self, settings: Settings, client: Any | None = None) -> None:
        self.settings = settings
        self.client = client or boto3.client("sagemaker-runtime", region_name=settings.aws_region)

    def run(self, parameters: PredictionParameters) -> RunSummary:
        response = self.client.invoke_endpoint(
            EndpointName=self.settings.sagemaker_endpoint_name,
            ContentType="application/json",
            Accept="application/json",
            Body=json.dumps(
                {"instances": [{}], "parameters": parameters.model_dump(mode="json")}
            ).encode("utf-8"),
        )
        payload = json.loads(response["Body"].read())
        predictions = payload.get("predictions") or []
        if not predictions:
            raise RuntimeError("SageMaker returned no predictions")
        return RunSummary.model_validate(predictions[0])
