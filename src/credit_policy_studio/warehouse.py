from __future__ import annotations

import json
from typing import Any, Protocol

from .models import Applicant, RunSummary, ScoringResult


class Warehouse(Protocol):
    def read_applicants(self, limit: int) -> list[Applicant]: ...

    def write_results(self, results: list[ScoringResult]) -> int: ...

    def write_run(self, summary: RunSummary) -> None: ...

    def list_runs(
        self, policy_version: str | None = None, limit: int = 50
    ) -> list[dict[str, Any]]: ...

    def dashboard(
        self, policy_version: str | None = None, run_id: str | None = None
    ) -> dict[str, Any]: ...


DEMO_APPLICANTS = [
    Applicant(
        user_id="USR-1001",
        score_1=742,
        score_2=84,
        score_3=91,
        variable_1=5200,
        variable_2=900,
        variable_3=46,
    ),
    Applicant(
        user_id="USR-1002",
        score_1=618,
        score_2=58,
        score_3=64,
        variable_1=3100,
        variable_2=1250,
        variable_3=18,
    ),
    Applicant(
        user_id="USR-1003",
        score_1=544,
        score_2=72,
        score_3=70,
        variable_1=2800,
        variable_2=600,
        variable_3=26,
    ),
    Applicant(
        user_id="USR-1004",
        score_1=691,
        score_2=43,
        score_3=59,
        variable_1=4400,
        variable_2=2100,
        variable_3=8,
    ),
    Applicant(
        user_id="USR-1005",
        score_1=775,
        score_2=91,
        score_3=87,
        variable_1=6800,
        variable_2=1100,
        variable_3=62,
    ),
    Applicant(
        user_id="USR-1006",
        score_1=582,
        score_2=66,
        score_3=52,
        variable_1=2500,
        variable_2=950,
        variable_3=14,
    ),
    Applicant(
        user_id="USR-1007",
        score_1=655,
        score_2=77,
        score_3=78,
        variable_1=3900,
        variable_2=850,
        variable_3=31,
    ),
    Applicant(
        user_id="USR-1008",
        score_1=509,
        score_2=39,
        score_3=45,
        variable_1=1900,
        variable_2=1200,
        variable_3=5,
    ),
]


class MemoryWarehouse:
    def __init__(self, applicants: list[Applicant] | None = None) -> None:
        self.applicants = applicants or DEMO_APPLICANTS
        self.results: list[ScoringResult] = []
        self.runs: list[RunSummary] = []

    def read_applicants(self, limit: int) -> list[Applicant]:
        return self.applicants[:limit]

    def write_results(self, results: list[ScoringResult]) -> int:
        self.results.extend(results)
        return len(results)

    def write_run(self, summary: RunSummary) -> None:
        self.runs.append(summary)

    def list_runs(self, policy_version: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        runs = [
            run for run in self.runs if not policy_version or run.policy_version == policy_version
        ]
        return [
            run.model_dump(mode="json")
            for run in sorted(runs, key=lambda item: item.completed_at, reverse=True)[:limit]
        ]

    def dashboard(
        self, policy_version: str | None = None, run_id: str | None = None
    ) -> dict[str, Any]:
        eligible_runs = [
            run
            for run in self.runs
            if (not policy_version or run.policy_version == policy_version)
            and (not run_id or run.run_id == run_id)
        ]
        latest_run = max(eligible_runs, key=lambda run: run.completed_at) if eligible_runs else None
        selected_run_id = run_id or (latest_run.run_id if latest_run else None)
        rows = [r for r in self.results if selected_run_id and r.run_id == selected_run_id]
        if not rows:
            return {"total": 0, "decisions": [], "nodes": [], "paths": [], "latest_run": None}
        decisions: dict[str, int] = {}
        nodes: dict[str, dict[str, Any]] = {}
        paths: dict[tuple[str, str, bool], int] = {}
        for row in rows:
            decisions[row.decision] = decisions.get(row.decision, 0) + 1
            nodes.setdefault(
                row.leaf_node_id, {"node_id": row.leaf_node_id, "label": row.decision, "count": 0}
            )["count"] += 1
            for step in row.trace:
                item = nodes.setdefault(
                    step.node_id, {"node_id": step.node_id, "label": step.label, "count": 0}
                )
                item["count"] += 1
                key = (step.node_id, step.next_node, step.branch)
                paths[key] = paths.get(key, 0) + 1
        return {
            "total": len(rows),
            "decisions": [
                {"decision": key, "count": value} for key, value in sorted(decisions.items())
            ],
            "nodes": list(nodes.values()),
            "paths": [
                {"source": source, "target": target, "branch": branch, "count": count}
                for (source, target, branch), count in paths.items()
            ],
            "latest_run": latest_run.model_dump(mode="json") if latest_run else None,
        }


class BigQueryWarehouse:
    def __init__(
        self,
        project_id: str,
        location: str,
        input_table: str,
        output_table: str,
        runs_table: str,
        client: Any | None = None,
    ) -> None:
        # Imported here so the AWS path never loads the Google Cloud SDK.
        from google.cloud import bigquery

        self.bigquery = bigquery
        self.location = location
        self.input_table = input_table
        self.output_table = output_table
        self.runs_table = runs_table
        self.client = client or bigquery.Client(project=project_id, location=location)

    def read_applicants(self, limit: int) -> list[Applicant]:
        query = f"""
            SELECT user_id, score_1, score_2, score_3, variable_1, variable_2, variable_3
            FROM `{self.input_table}`
            ORDER BY user_id
            LIMIT @limit
        """
        config = self.bigquery.QueryJobConfig(
            query_parameters=[self.bigquery.ScalarQueryParameter("limit", "INT64", limit)]
        )
        return [
            Applicant.model_validate(dict(row))
            for row in self.client.query(query, job_config=config, location=self.location).result()
        ]

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
        errors = self.client.insert_rows_json(self.output_table, payload)
        if errors:
            raise RuntimeError(f"BigQuery rejected scoring results: {errors}")
        return len(payload)

    def write_run(self, summary: RunSummary) -> None:
        row = summary.model_dump(mode="json")
        row["decisions"] = json.dumps(row["decisions"], separators=(",", ":"))
        errors = self.client.insert_rows_json(self.runs_table, [row])
        if errors:
            raise RuntimeError(f"BigQuery rejected run metadata: {errors}")

    def list_runs(self, policy_version: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
        filters = "WHERE policy_version = @policy_version" if policy_version else ""
        parameters = [self.bigquery.ScalarQueryParameter("limit", "INT64", limit)]
        if policy_version:
            parameters.append(
                self.bigquery.ScalarQueryParameter("policy_version", "STRING", policy_version)
            )
        query = f"""
            SELECT * FROM `{self.runs_table}`
            {filters}
            ORDER BY completed_at DESC
            LIMIT @limit
        """
        rows = self.client.query(
            query,
            job_config=self.bigquery.QueryJobConfig(query_parameters=parameters),
            location=self.location,
        ).result()
        return [dict(row) for row in rows]

    def dashboard(
        self, policy_version: str | None = None, run_id: str | None = None
    ) -> dict[str, Any]:
        run_filters = []
        run_parameters = []
        if policy_version:
            run_filters.append("policy_version = @policy_version")
            run_parameters.append(
                self.bigquery.ScalarQueryParameter("policy_version", "STRING", policy_version)
            )
        if run_id:
            run_filters.append("run_id = @requested_run_id")
            run_parameters.append(
                self.bigquery.ScalarQueryParameter("requested_run_id", "STRING", run_id)
            )
        where = f"WHERE {' AND '.join(run_filters)}" if run_filters else ""
        latest_run_query = f"""
            SELECT * FROM `{self.runs_table}`
            {where}
            ORDER BY completed_at DESC LIMIT 1
        """
        latest_rows = list(
            self.client.query(
                latest_run_query,
                job_config=self.bigquery.QueryJobConfig(query_parameters=run_parameters),
                location=self.location,
            ).result()
        )
        if not latest_rows:
            return {"total": 0, "decisions": [], "nodes": [], "paths": [], "latest_run": None}
        latest_run = dict(latest_rows[0])
        selected_run_id = latest_run["run_id"]
        config = self.bigquery.QueryJobConfig(
            query_parameters=[
                self.bigquery.ScalarQueryParameter("run_id", "STRING", selected_run_id)
            ]
        )
        decision_query = f"""
            SELECT decision, COUNT(*) AS count
            FROM `{self.output_table}`
            WHERE run_id = @run_id
            GROUP BY decision ORDER BY count DESC
        """
        decision_rows = list(
            self.client.query(decision_query, job_config=config, location=self.location).result()
        )
        node_query = f"""
            WITH filtered AS (
              SELECT leaf_node_id, decision, trace_json
              FROM `{self.output_table}`
              WHERE run_id = @run_id
            ), visited AS (
              SELECT
                JSON_VALUE(step, '$.node_id') AS node_id,
                JSON_VALUE(step, '$.label') AS label
              FROM filtered, UNNEST(JSON_QUERY_ARRAY(trace_json)) AS step
              UNION ALL
              SELECT leaf_node_id, decision FROM filtered
            )
            SELECT node_id, ANY_VALUE(label) AS label, COUNT(*) AS count
            FROM visited GROUP BY node_id ORDER BY count DESC
        """
        path_query = f"""
            SELECT
              JSON_VALUE(step, '$.node_id') AS source,
              JSON_VALUE(step, '$.next_node') AS target,
              JSON_VALUE(step, '$.branch') = 'true' AS branch,
              COUNT(*) AS count
            FROM `{self.output_table}`,
              UNNEST(JSON_QUERY_ARRAY(trace_json)) AS step
            WHERE run_id = @run_id
            GROUP BY source, target, branch ORDER BY count DESC
        """
        node_rows = list(
            self.client.query(node_query, job_config=config, location=self.location).result()
        )
        path_rows = list(
            self.client.query(path_query, job_config=config, location=self.location).result()
        )
        total = sum(row.count for row in decision_rows)
        return {
            "total": total,
            "decisions": [dict(row) for row in decision_rows],
            "nodes": [dict(row) for row in node_rows],
            "paths": [dict(row) for row in path_rows],
            "latest_run": latest_run,
        }
