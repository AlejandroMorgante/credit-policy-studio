import json
from hashlib import sha256
from pathlib import Path

import pytest
from pydantic import ValidationError

from credit_policy_studio.engine import DecisionEngine, policy_sha256
from credit_policy_studio.models import Applicant, ConditionValidation, CreditPolicy, ScoringResult
from credit_policy_studio.warehouse import DEMO_APPLICANTS

POLICY_PATH = Path(__file__).parents[1] / "policies" / "credit_policy_v1.json"


@pytest.fixture
def policy() -> CreditPolicy:
    return CreditPolicy.model_validate_json(POLICY_PATH.read_text())


def test_prime_applicant_has_version_hash_and_full_trace(policy: CreditPolicy) -> None:
    applicant = Applicant(
        user_id="USR-PRIME",
        score_1=780,
        score_2=88,
        score_3=92,
        variable_1=7000,
        variable_2=900,
        variable_3=50,
    )

    result = DecisionEngine(policy).evaluate(applicant, "run-1")

    assert result.decision == "APPROVED"
    assert result.risk_band == "A"
    assert result.policy_version == "2026-09-09.1"
    assert result.policy_sha256 == policy_sha256(policy)
    assert [step.node_id for step in result.trace] == [
        "bureau-floor",
        "affordability",
        "behavior",
        "income",
        "tenure",
    ]


def test_low_bureau_score_is_rejected(policy: CreditPolicy) -> None:
    applicant = Applicant(
        user_id="USR-RISKY",
        score_1=510,
        score_2=90,
        score_3=90,
        variable_1=9000,
        variable_2=100,
        variable_3=80,
    )

    result = DecisionEngine(policy).evaluate(applicant, "run-2")

    assert result.decision == "REJECTED"
    assert result.reason_code == "BUREAU_SCORE_BELOW_POLICY"
    assert len(result.trace) == 1
    assert result.trace[0].branch is False


def test_policy_rejects_cycles(policy: CreditPolicy) -> None:
    payload = json.loads(policy.model_dump_json())
    payload["nodes"]["bureau-floor"]["false_node"] = "bureau-floor"

    with pytest.raises(ValidationError, match="cycle detected"):
        CreditPolicy.model_validate(payload)


def combined_payload(policy: CreditPolicy, combination: str, validations: list[dict]) -> dict:
    payload = policy.model_dump(mode="json")
    node = payload["nodes"][policy.root_node]
    for key in ("field", "operator", "value"):
        del node[key]
    node.update(combination=combination, validations=validations)
    return payload


@pytest.mark.parametrize("combination", ["AND", "OR"])
@pytest.mark.parametrize("score", [None, 0, 600, 650, 700])
@pytest.mark.parametrize("reverse", [False, True])
def test_combined_presence_and_threshold(policy, combination, score, reverse) -> None:
    validations = [
        {"field": "score_1", "operator": "has_value", "value": True},
        {"field": "score_1", "operator": "gt", "value": 650},
    ]
    if reverse:
        validations.reverse()
    combined = CreditPolicy.model_validate(combined_payload(policy, combination, validations))
    applicant = DEMO_APPLICANTS[0].model_copy(update={"score_1": score})
    result = DecisionEngine(combined).evaluate(applicant, "combined-run")

    step = result.trace[0]
    expected = score is not None and (combination == "OR" or score > 650)
    assert step.branch is expected
    assert step.next_node == (
        combined.nodes[policy.root_node].true_node
        if expected
        else combined.nodes[policy.root_node].false_node
    )
    assert step.combination == combination
    assert [check.operator for check in step.validations] == [v["operator"] for v in validations]
    assert len(step.validations) == 2
    assert all(check.observed == score for check in step.validations)
    assert len([item for item in result.trace if item.node_id == policy.root_node]) == 1
    assert result.score_1 == score
    assert ScoringResult.model_validate_json(result.model_dump_json()) == result


@pytest.mark.parametrize("operator", ["is_null", "has_value"])
@pytest.mark.parametrize("threshold", [True, False])
@pytest.mark.parametrize("score", [None, 0, 700])
def test_null_operators_with_yes_and_no(policy, operator, threshold, score) -> None:
    node = policy.nodes[policy.root_node]
    node.operator = operator
    node.value = threshold
    applicant = Applicant(user_id="nullable", score_1=score)
    step = DecisionEngine(policy).evaluate(applicant, "null-run").trace[0]
    presence = score is None if operator == "is_null" else score is not None
    assert step.branch is (presence == threshold)


@pytest.mark.parametrize("operator", ["lt", "lte", "gt", "gte", "eq", "neq", "in"])
def test_ordinary_comparisons_of_missing_features_are_false(policy, operator) -> None:
    node = policy.nodes[policy.root_node]
    node.operator = operator
    node.value = [650] if operator == "in" else 650
    result = DecisionEngine(policy).evaluate(Applicant(user_id="missing"), "null-run")
    assert result.trace[0].observed is None
    assert result.trace[0].branch is False


@pytest.mark.parametrize("operator", ["is_null", "has_value"])
@pytest.mark.parametrize("value", [None, "yes", "false", 0, 1, [], {}])
def test_null_operators_require_boolean_threshold(operator, value) -> None:
    with pytest.raises(ValidationError, match="boolean threshold"):
        ConditionValidation(field="score_1", operator=operator, value=value)


@pytest.mark.parametrize(
    ("combination", "count"), [("AND", 0), ("OR", 0), ("none", 0), ("none", 2), ("XOR", 1)]
)
def test_invalid_combinations_are_rejected(policy, combination, count) -> None:
    validations = [{"field": "score_1", "operator": "gte", "value": 650}] * count
    with pytest.raises(ValidationError):
        CreditPolicy.model_validate(combined_payload(policy, combination, validations))


@pytest.mark.parametrize("combination", ["AND", "OR", "none"])
def test_single_validation_in_each_combination(policy, combination) -> None:
    validations = [{"field": "score_1", "operator": "gte", "value": 650}]
    combined = CreditPolicy.model_validate(combined_payload(policy, combination, validations))
    result = DecisionEngine(combined).evaluate(DEMO_APPLICANTS[0], "single")
    assert result.trace[0].branch is True


def test_combined_condition_rejects_legacy_fields(policy) -> None:
    payload = combined_payload(
        policy, "AND", [{"field": "score_1", "operator": "gte", "value": 650}]
    )
    payload["nodes"][policy.root_node]["field"] = "score_2"
    with pytest.raises(ValidationError):
        CreditPolicy.model_validate(payload)


@pytest.mark.parametrize("target", ["missing-node", "bureau-floor"])
def test_combined_condition_validates_graph(policy, target) -> None:
    payload = combined_payload(
        policy, "AND", [{"field": "score_1", "operator": "gte", "value": 650}]
    )
    payload["nodes"][policy.root_node]["true_node"] = target
    with pytest.raises(ValidationError, match="missing node|cycle detected"):
        CreditPolicy.model_validate(payload)


def test_legacy_policy_serialization_and_hash_are_unchanged(policy) -> None:
    original = json.loads(POLICY_PATH.read_text())
    # Timestamps and credit limits were normalized by the original models too.
    original["metadata"] = policy.metadata.model_dump(mode="json")
    for node in original["nodes"].values():
        if node["type"] == "decision":
            node["credit_limit"] = float(node["credit_limit"])
    assert policy.model_dump(mode="json") == original
    expected = sha256(json.dumps(original, sort_keys=True, separators=(",", ":")).encode())
    assert policy_sha256(policy) == expected.hexdigest()


def test_combined_hash_includes_combination_and_all_validations(policy) -> None:
    payload = combined_payload(
        policy,
        "AND",
        [
            {"field": "score_1", "operator": "has_value", "value": True},
            {"field": "score_1", "operator": "gt", "value": 650},
        ],
    )
    first = policy_sha256(CreditPolicy.model_validate(payload))
    payload["nodes"][policy.root_node]["combination"] = "OR"
    second = policy_sha256(CreditPolicy.model_validate(payload))
    payload["nodes"][policy.root_node]["validations"][1]["value"] = 700
    third = policy_sha256(CreditPolicy.model_validate(payload))
    assert len({first, second, third}) == 3


@pytest.fixture
def sql_demo_policy() -> CreditPolicy:
    source = POLICY_PATH.with_name("credit_policy_sql_demo.json")
    return CreditPolicy.model_validate_json(source.read_text())


@pytest.mark.parametrize(
    ("features", "reason", "limit"),
    [
        ({"variable_1": None}, "DEMO_R05_INCOME", 0),
        ({"variable_1": 999}, "DEMO_R05_INCOME", 0),
        ({"score_1": None, "score_3": None}, "DEMO_R06_SCORE_UNAVAILABLE", 0),
        ({"score_3": 35}, "DEMO_R07_MANUAL_REVIEW", 0),
        ({"score_3": 60, "variable_3": 0}, "DEMO_CLUSTER_D_CAP", 4000),
        ({"score_3": 80, "variable_3": 0}, "DEMO_R07_MANUAL_REVIEW", 0),
        ({"score_3": 81, "variable_3": 0}, "DEMO_CLUSTER_C_CAP", 8000),
        ({"score_3": 81, "variable_3": 4}, "DEMO_CLUSTER_B_CAP", 18000),
        ({"score_3": 81, "variable_3": 24}, "DEMO_CLUSTER_A_CAP", 25000),
        ({"score_3": None, "score_1": 740}, "DEMO_CLUSTER_B_CAP", 18000),
        ({"score_3": None, "score_1": 630}, "DEMO_CLUSTER_D_CAP", 4000),
        ({"score_3": None, "score_1": 492.5}, "DEMO_R07_MANUAL_REVIEW", 0),
        # Behavior remains authoritative even if the alternate bureau score is better.
        ({"score_3": 35, "score_1": 850}, "DEMO_R07_MANUAL_REVIEW", 0),
        ({"score_3": 90, "score_1": None}, "DEMO_CLUSTER_A_CAP", 25000),
        ({"variable_2": None}, "DEMO_R08_NO_PAYMENT_CAPACITY", 0),
        ({"variable_2": -1}, "DEMO_R08_NO_PAYMENT_CAPACITY", 0),
        ({"variable_1": 1000, "variable_2": 349}, "DEMO_CLUSTER_A_BASE", 4000),
        ({"variable_1": 1000, "variable_2": 350}, "DEMO_R08_NO_PAYMENT_CAPACITY", 0),
        ({"variable_1": 2999}, "DEMO_CLUSTER_A_BASE", 4000),
        ({"variable_1": 3000}, "DEMO_CLUSTER_A_MID", 12000),
        ({"variable_1": 6249}, "DEMO_CLUSTER_A_MID", 12000),
        ({"variable_1": 6250}, "DEMO_CLUSTER_A_CAP", 25000),
        ({"score_3": 70, "variable_1": 1000}, "DEMO_CLUSTER_B_BASE", 3000),
        ({"score_3": 70, "variable_1": 3000}, "DEMO_CLUSTER_B_MID", 9000),
        ({"variable_3": 0, "variable_1": 1000}, "DEMO_CLUSTER_C_BASE", 1500),
        ({"variable_3": 0, "variable_1": 3000}, "DEMO_CLUSTER_C_MID", 4500),
        ({"score_3": 50, "variable_1": 1000}, "DEMO_CLUSTER_D_BASE", 1000),
        ({"score_3": 50, "variable_1": 3000}, "DEMO_CLUSTER_D_MID", 3000),
    ],
)
def test_sql_demo_adapted_rules(sql_demo_policy, features, reason, limit) -> None:
    applicant = Applicant.model_validate(
        {
            "user_id": "sql-demo",
            "score_3": 90,
            "variable_1": 7000,
            "variable_2": 0,
            "variable_3": 24,
            **features,
        }
    )
    result = DecisionEngine(sql_demo_policy).evaluate(applicant, "sql-demo-rules")
    assert result.reason_code == reason
    assert result.credit_limit == limit
    assert result.decision == (
        "APPROVED" if limit else "REVIEW" if reason == "DEMO_R07_MANUAL_REVIEW" else "REJECTED"
    )


def test_sql_demo_uses_only_current_nodes_and_features(sql_demo_policy) -> None:
    from credit_policy_studio.models import CombinedConditionNode, DecisionNode

    assert sql_demo_policy.metadata.status == "draft"
    for node in sql_demo_policy.nodes.values():
        assert isinstance(node, (CombinedConditionNode, DecisionNode))
        if isinstance(node, CombinedConditionNode):
            assert all(
                validation.field in Applicant.model_fields for validation in node.validations
            )

    results = [DecisionEngine(sql_demo_policy).evaluate(a, "demo") for a in DEMO_APPLICANTS]
    assert sum(result.decision == "APPROVED" for result in results) == 2
    assert sum(result.decision == "REJECTED" for result in results) == 6
