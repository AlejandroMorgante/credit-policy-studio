from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime
from uuid import uuid4

from .engine import DecisionEngine
from .models import PredictionParameters, RunSummary
from .repositories import PolicyRepository
from .warehouse import Warehouse


class ScoringService:
    def __init__(self, policies: PolicyRepository, warehouse: Warehouse) -> None:
        self.policies = policies
        self.warehouse = warehouse

    def run(self, parameters: PredictionParameters) -> RunSummary:
        started_at = datetime.now(UTC)
        run_id = parameters.run_id or str(uuid4())
        policy = (
            self.policies.get_version(parameters.policy_version)
            if parameters.policy_version
            else self.policies.get_active()
        )
        engine = DecisionEngine(policy)
        applicants = self.warehouse.read_applicants(parameters.limit)
        results = [engine.evaluate(applicant, run_id) for applicant in applicants]
        persisted = 0 if parameters.dry_run else self.warehouse.write_results(results)
        completed_at = datetime.now(UTC)
        summary = RunSummary(
            run_id=run_id,
            policy_id=policy.metadata.policy_id,
            policy_version=policy.metadata.version,
            policy_sha256=engine.sha256,
            processed_rows=len(results),
            persisted_rows=persisted,
            decisions=dict(Counter(result.decision for result in results)),
            started_at=started_at,
            completed_at=completed_at,
            duration_ms=int((completed_at - started_at).total_seconds() * 1000),
        )
        if not parameters.dry_run:
            self.warehouse.write_run(summary)
        return summary
