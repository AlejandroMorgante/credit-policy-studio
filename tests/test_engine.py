import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from credit_policy_studio.engine import DecisionEngine, policy_sha256
from credit_policy_studio.models import Applicant, CreditPolicy

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
