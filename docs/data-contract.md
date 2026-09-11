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

The six numeric features may be `null`; omitted features are read as `null`. `user_id` remains
required. Results preserve these nulls. An ordinary comparison of a null feature returns false
(including `neq`); use `is_null` or `has_value` with a boolean threshold to test presence explicitly.
Zero counts as a value. BigQuery input and output feature columns are `NULLABLE`. Existing
deployments must apply the schema relaxation before ingesting or persisting null features.

Condition nodes accept the original `field` / `operator` / `value` shape or a `combination`
(`AND`, `OR`, `none`) and a nonempty `validations` array of those triples. The shapes cannot be
mixed, and `none` requires exactly one validation. For example:

```json
{
  "id": "bureau-floor",
  "type": "condition",
  "label": "Score presente y suficiente",
  "combination": "AND",
  "validations": [
    {"field": "score_1", "operator": "has_value", "value": true},
    {"field": "score_1", "operator": "gt", "value": 650}
  ],
  "true_node": "affordability",
  "false_node": "reject-bureau"
}
```

This is an additive extension of schema `1.0`: existing policies retain their serialized shape and
SHA-256. Upgrade the serving runtime before evaluating policies using the new shape or operators.
Each combined node emits one trace step with `node_id`, `label`, `branch`, `next_node`, `combination`,
and `validations`. Each validation records `field`, `operator`, `threshold`, `observed`, and `branch`.
All validations are evaluated in order for auditability; node and path counts still count a block
once. Legacy nodes retain their original flat trace format.

All data in this repository is synthetic. The sample policy is illustrative and must not be used to
make real credit decisions. A real deployment needs legal, fairness, model-risk, privacy, adverse-
action, retention, and human-review controls appropriate to its jurisdiction.
