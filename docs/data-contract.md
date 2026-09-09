# Data contract

The input table intentionally uses generic names requested for the POC. Their fictional meanings are:

| Column | Meaning | Range/example |
|---|---|---|
| `user_id` | Synthetic person identifier | `USR-1001` |
| `score_1` | Credit bureau score | 300–850 |
| `score_2` | Affordability score | 0–100 |
| `score_3` | Payment behavior score | 0–100 |
| `variable_1` | Monthly income | positive currency amount |
| `variable_2` | Monthly debt obligation | positive currency amount |
| `variable_3` | Employment tenure | months |

All data in this repository is synthetic. The sample policy is illustrative and must not be used to
make real credit decisions. A real deployment needs legal, fairness, model-risk, privacy, adverse-
action, retention, and human-review controls appropriate to its jurisdiction.
