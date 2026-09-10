import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from credit_policy_studio.engine import DecisionEngine
from credit_policy_studio.models import Applicant, CreditPolicy


@pytest.fixture
def engine() -> DecisionEngine:
    path = Path(__file__).parents[1] / "policies" / "credit_policy_cascade.json"
    return DecisionEngine(CreditPolicy.model_validate_json(path.read_text()))


def applicant(**overrides) -> Applicant:
    values = {
        "user_id": "USR-TEST",
        "account_id": "ACC-TEST",
        "age": 35,
        "account_tenure_months": 12,
        "declared_income": 7000,
        "estimated_monthly_debt": 500,
        "maximum_days_past_due_12m": 0,
        "completed_loans": 3,
        "is_restricted": False,
        "has_recent_default": False,
        "behavior_score": 0.15,
        "behavior_score_version": "demo_behavior_v1",
        "application_score": None,
        "application_score_version": None,
    }
    return Applicant.model_validate(values | overrides)


def test_cluster_a_offer_matches_sql_cascade(engine: DecisionEngine) -> None:
    result = engine.evaluate(applicant(), "run-a")

    assert result.decision == "APPROVED"
    assert result.score_source == "BEHAVIOR_MODEL"
    assert result.customer_population == "RETURNING_CUSTOMER"
    assert result.risk_band == "LOW"
    assert result.credit_cluster == "DEMO_CLUSTER_A"
    assert result.maximum_installment == 1950
    assert result.credit_limit == 25000


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"is_restricted": True}, "DEMO_R01_RESTRICTED"),
        ({"has_recent_default": True}, "DEMO_R02_RECENT_DEFAULT"),
        ({"age": 18}, "DEMO_R03_AGE"),
        ({"maximum_days_past_due_12m": 26}, "DEMO_R04_PAYMENT_HISTORY"),
        ({"declared_income": None}, "DEMO_R05_INCOME"),
        ({"behavior_score": None}, "DEMO_R06_SCORE_UNAVAILABLE"),
    ],
)
def test_first_eligibility_failure_wins(engine: DecisionEngine, changes: dict, reason: str) -> None:
    result = engine.evaluate(applicant(**changes), "run-rejected")
    assert result.decision == "REJECTED"
    assert result.reason_code == reason


def test_high_risk_without_cluster_goes_to_review(engine: DecisionEngine) -> None:
    result = engine.evaluate(applicant(behavior_score=0.8), "run-review")
    assert result.decision == "REVIEW"
    assert result.reason_code == "DEMO_R07_MANUAL_REVIEW"


def test_application_score_is_used_as_fallback(engine: DecisionEngine) -> None:
    result = engine.evaluate(
        applicant(
            behavior_score=None,
            behavior_score_version=None,
            application_score=0.3,
            application_score_version="demo_application_v1",
        ),
        "run-application",
    )
    assert result.score_source == "APPLICATION_MODEL"
    assert result.risk_band == "MEDIUM_LOW"
    assert result.decision == "APPROVED"


def test_unknown_expression_operator_is_rejected() -> None:
    path = Path(__file__).parents[1] / "policies" / "credit_policy_cascade.json"
    payload = json.loads(path.read_text())
    payload["nodes"]["restricted"]["expression"] = {"op": "execute", "args": []}

    with pytest.raises(ValidationError, match="unsupported expression operator"):
        CreditPolicy.model_validate(payload)
