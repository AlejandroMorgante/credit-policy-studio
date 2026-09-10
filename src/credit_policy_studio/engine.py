from __future__ import annotations

import hashlib
import json

from .expressions import COMPARISONS, evaluate
from .models import (
    Applicant,
    ConditionNode,
    CreditPolicy,
    DecisionNode,
    DeriveNode,
    ScoringResult,
    TraceStep,
)


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
                outputs = {key: evaluate(value, fields) for key, value in node.outputs.items()}
                for name in (
                    "account_id",
                    "score_source",
                    "customer_population",
                    "credit_cluster",
                    "maximum_installment",
                ):
                    if name in fields:
                        outputs.setdefault(name, fields[name])
                risk_band = outputs.pop("risk_band", node.risk_band)
                credit_limit = outputs.pop("credit_limit", node.credit_limit)
                reason_code = outputs.pop("reason_code", node.reason_code)
                result_fields = applicant.model_dump(exclude={"user_id"}) | outputs
                return ScoringResult(
                    run_id=run_id,
                    user_id=applicant.user_id,
                    policy_id=self.policy.metadata.policy_id,
                    policy_version=self.policy.metadata.version,
                    policy_sha256=self.sha256,
                    decision=node.decision,
                    risk_band=risk_band,
                    credit_limit=credit_limit,
                    reason_code=reason_code,
                    leaf_node_id=node.id,
                    trace=trace,
                    **result_fields,
                )

            if isinstance(node, DeriveNode):
                for name, expression in node.assignments.items():
                    fields[name] = evaluate(expression, fields)
                trace.append(
                    TraceStep(
                        node_id=node.id,
                        label=node.label,
                        observed={name: fields[name] for name in node.assignments},
                        threshold=None,
                        branch=True,
                        next_node=node.next_node,
                    )
                )
                node_id = node.next_node
                continue

            if not isinstance(node, ConditionNode):
                raise TypeError(f"Unsupported node type at {node_id!r}")
            if node.expression is not None:
                observed = evaluate(node.expression, fields)
                branch = bool(observed)
                threshold = True
            elif node.field not in fields:
                raise ValueError(f"Applicant is missing field {node.field!r}")
            else:
                observed = fields[node.field]
                branch = COMPARISONS[node.operator](observed, node.value)
                threshold = node.value
            next_node = node.true_node if branch else node.false_node
            trace.append(
                TraceStep(
                    node_id=node.id,
                    label=node.label,
                    field=node.field,
                    operator=node.operator,
                    threshold=threshold,
                    observed=observed,
                    branch=branch,
                    next_node=next_node,
                )
            )
            node_id = next_node

        raise RuntimeError("Policy evaluation exceeded the maximum number of steps")
