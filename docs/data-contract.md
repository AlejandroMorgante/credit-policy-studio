# Data contract

The cascade input is a flattened, synthetic projection of the source used by the reference SQL:

| Column | Meaning | Range/example |
|---|---|---|
| `user_id`, `account_id` | Synthetic person and account identifiers | `USR-1001`, `ACC-1001` |
| `age` | Customer age | years |
| `account_tenure_months` | Account tenure | months |
| `declared_income` | Declared monthly income | nullable amount |
| `estimated_monthly_debt` | Estimated monthly debt | amount |
| `maximum_days_past_due_12m` | Worst delinquency in the last year | days |
| `completed_loans` | Completed loan count | integer |
| `is_restricted`, `has_recent_default` | Exclusion flags | boolean |
| `behavior_score`, `application_score` | Candidate risk scores | 0–1, nullable |
| `behavior_score_version`, `application_score_version` | Score model versions | string, nullable |

The nested `risk_scores` value in `Example` is flattened at the warehouse boundary. The policy
itself selects the usable score, derives population, risk band, cluster and commercial terms, and
calculates `maximum_installment` and `credit_limit`.

All data in this repository is synthetic. The sample policy is illustrative and must not be used to
make real credit decisions. A real deployment needs legal, fairness, model-risk, privacy, adverse-
action, retention, and human-review controls appropriate to its jurisdiction.
