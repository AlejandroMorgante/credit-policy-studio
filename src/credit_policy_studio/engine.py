from __future__ import annotations

import hashlib
import json
import operator
from collections.abc import Callable
from typing import Any

from .models import Applicant, ConditionNode, CreditPolicy, DecisionNode, ScoringResult, TraceStep

OPERATORS: dict[str, Callable[[Any, Any], bool]] = {
    "lt": operator.lt,
    "lte": operator.le,
    "gt": operator.gt,
    "gte": operator.ge,
    "eq": operator.eq,
    "neq": operator.ne,
    "in": lambda observed, expected: observed in expected,
}


def policy_sha256(policy: CreditPolicy) -> str:
    canonical = json.dumps(
        policy.model_dump(mode="json"), sort_keys=True, separators=(",", ":")
    ).encode()
    return hashlib.sha256(canonical).hexdigest()


class DecisionEngine:
    def __init__(self, policy: CreditPolicy) -> None:
        self.policy = policy
        self.sha256 = policy_sha256(policy)

    def evaluate(self, applicant: Applicant, run_id: str) -> ScoringResult:
        fields = applicant.model_dump()
        node_id = self.policy.root_node
        trace: list[TraceStep] = []
        max_steps = len(self.policy.nodes) + 1

        for _ in range(max_steps):
            node = self.policy.nodes[node_id]
            if isinstance(node, DecisionNode):
                return ScoringResult(
                    run_id=run_id,
                    user_id=applicant.user_id,
                    policy_id=self.policy.metadata.policy_id,
                    policy_version=self.policy.metadata.version,
                    policy_sha256=self.sha256,
                    decision=node.decision,
                    risk_band=node.risk_band,
                    credit_limit=node.credit_limit,
                    reason_code=node.reason_code,
                    leaf_node_id=node.id,
                    trace=trace,
                    **applicant.model_dump(exclude={"user_id"}),
                )

            if not isinstance(node, ConditionNode):
                raise TypeError(f"Unsupported node type at {node_id!r}")
            if node.field not in fields:
                raise ValueError(f"Applicant is missing field {node.field!r}")

            observed = fields[node.field]
            branch = OPERATORS[node.operator](observed, node.value)
            next_node = node.true_node if branch else node.false_node
            trace.append(
                TraceStep(
                    node_id=node.id,
                    label=node.label,
                    field=node.field,
                    operator=node.operator,
                    threshold=node.value,
                    observed=observed,
                    branch=branch,
                    next_node=next_node,
                )
            )
            node_id = next_node

        raise RuntimeError("Policy evaluation exceeded the maximum number of steps")
