from __future__ import annotations

from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Operator = Literal["lt", "lte", "gt", "gte", "eq", "neq", "in"]


class PolicyMetadata(BaseModel):
    policy_id: str
    version: str
    name: str
    description: str = ""
    created_at: datetime
    created_by: str
    status: Literal["draft", "active", "retired"] = "draft"


class ConditionNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: Literal["condition"]
    label: str
    field: str
    operator: Operator
    value: Any
    true_node: str
    false_node: str


class DecisionNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    type: Literal["decision"]
    label: str
    decision: Literal["APPROVED", "REVIEW", "REJECTED"]
    risk_band: str
    credit_limit: float = Field(ge=0)
    reason_code: str


Node = ConditionNode | DecisionNode


class CreditPolicy(BaseModel):
    schema_version: Literal["1.0"]
    metadata: PolicyMetadata
    root_node: str
    nodes: dict[str, Node]

    @model_validator(mode="after")
    def validate_graph(self) -> CreditPolicy:
        if self.root_node not in self.nodes:
            raise ValueError("root_node does not exist")
        for key, node in self.nodes.items():
            if key != node.id:
                raise ValueError(f"node key {key!r} does not match id {node.id!r}")
            if isinstance(node, ConditionNode):
                for target in (node.true_node, node.false_node):
                    if target not in self.nodes:
                        raise ValueError(f"node {node.id!r} references missing node {target!r}")
        self._validate_acyclic()
        return self

    def _validate_acyclic(self) -> None:
        visiting: set[str] = set()
        visited: set[str] = set()

        def visit(node_id: str) -> None:
            if node_id in visiting:
                raise ValueError(f"cycle detected at node {node_id!r}")
            if node_id in visited:
                return
            visiting.add(node_id)
            node = self.nodes[node_id]
            if isinstance(node, ConditionNode):
                visit(node.true_node)
                visit(node.false_node)
            visiting.remove(node_id)
            visited.add(node_id)

        visit(self.root_node)


class Applicant(BaseModel):
    user_id: str
    score_1: float
    score_2: float
    score_3: float
    variable_1: float
    variable_2: float
    variable_3: float


class TraceStep(BaseModel):
    node_id: str
    label: str
    field: str
    operator: Operator
    threshold: Any
    observed: Any
    branch: bool
    next_node: str


class ScoringResult(BaseModel):
    run_id: str
    user_id: str
    policy_id: str
    policy_version: str
    policy_sha256: str
    decision: str
    risk_band: str
    credit_limit: float
    reason_code: str
    leaf_node_id: str
    trace: list[TraceStep]
    evaluated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    score_1: float
    score_2: float
    score_3: float
    variable_1: float
    variable_2: float
    variable_3: float


class PredictionParameters(BaseModel):
    limit: int = Field(default=100, ge=1, le=10000)
    run_id: str | None = None
    policy_version: str | None = None
    dry_run: bool = False


class VertexPredictionRequest(BaseModel):
    instances: list[dict[str, Any]] = Field(default_factory=lambda: [{}])
    parameters: PredictionParameters = Field(default_factory=PredictionParameters)


class RunSummary(BaseModel):
    run_id: str
    policy_id: str
    policy_version: str
    policy_sha256: str
    processed_rows: int
    persisted_rows: int
    decisions: dict[str, int]
    started_at: datetime
    completed_at: datetime
    duration_ms: int


class PublishPolicyRequest(BaseModel):
    policy: CreditPolicy
