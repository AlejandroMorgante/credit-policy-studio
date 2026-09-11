-- ============================================================================
-- POLITICA DE CREDITO DEMO
-- ============================================================================
-- Ejemplo ficticio para demostrar una cascada de decisiones.
-- Los nombres, fuentes, modelos, codigos, montos y umbrales son sinteticos.
-- No representa una politica productiva ni debe utilizarse para originacion real.

DECLARE evaluation_date DATE DEFAULT CURRENT_DATE();
DECLARE minimum_age INT64 DEFAULT 21;
DECLARE maximum_age INT64 DEFAULT 70;
DECLARE maximum_days_past_due INT64 DEFAULT 25;
DECLARE minimum_account_tenure_months INT64 DEFAULT 4;
DECLARE minimum_income NUMERIC DEFAULT 1000;

WITH
-- La fuente es deliberadamente generica. Para una demo ejecutable puede
-- reemplazarse por una tabla temporal con datos sinteticos.
source_data AS (
  SELECT
    customer_id,
    account_id,
    snapshot_date,
    age,
    account_tenure_months,
    declared_income,
    estimated_monthly_debt,
    maximum_days_past_due_12m,
    active_credit_products,
    completed_loans,
    recent_purchase_count,
    recent_purchase_amount,
    is_restricted,
    has_recent_default,
    risk_scores
  FROM `demo_project.demo_credit.synthetic_customer_features`
  WHERE snapshot_date = evaluation_date
),

-- Elegimos un score segun la informacion disponible. Los modelos y sus
-- versiones son ficticios y solo ilustran la prioridad entre fuentes.
normalized_scores AS (
  SELECT
    *,
    CASE
      WHEN risk_scores.behavior IS NOT NULL
        AND LAX_STRING(risk_scores.behavior.version) = 'demo_behavior_v1'
        THEN LAX_FLOAT64(risk_scores.behavior.value)
      WHEN risk_scores.application IS NOT NULL
        AND LAX_STRING(risk_scores.application.version) = 'demo_application_v1'
        THEN LAX_FLOAT64(risk_scores.application.value)
      ELSE NULL
    END AS risk_score,
    CASE
      WHEN risk_scores.behavior IS NOT NULL THEN 'BEHAVIOR_MODEL'
      WHEN risk_scores.application IS NOT NULL THEN 'APPLICATION_MODEL'
      ELSE 'NO_MODEL'
    END AS score_source
  FROM source_data
),

-- Filtros excluyentes resumidos. Se devuelve el primer motivo aplicable.
eligibility AS (
  SELECT
    *,
    CASE
      WHEN is_restricted THEN 'DEMO_R01_RESTRICTED'
      WHEN has_recent_default THEN 'DEMO_R02_RECENT_DEFAULT'
      WHEN age < minimum_age OR age > maximum_age THEN 'DEMO_R03_AGE'
      WHEN maximum_days_past_due_12m > maximum_days_past_due
        THEN 'DEMO_R04_PAYMENT_HISTORY'
      WHEN declared_income IS NULL OR declared_income < minimum_income
        THEN 'DEMO_R05_INCOME'
      WHEN risk_score IS NULL THEN 'DEMO_R06_SCORE_UNAVAILABLE'
      ELSE NULL
    END AS eligibility_error
  FROM normalized_scores
),

-- Tres poblaciones sencillas sustituyen una clasificacion mas detallada.
population AS (
  SELECT
    *,
    CASE
      WHEN completed_loans >= 2 THEN 'RETURNING_CUSTOMER'
      WHEN account_tenure_months >= minimum_account_tenure_months
        THEN 'ESTABLISHED_CUSTOMER'
      ELSE 'NEW_CUSTOMER'
    END AS customer_population
  FROM eligibility
),

-- Segmentacion ficticia y compacta: cuatro niveles de riesgo.
risk_segment AS (
  SELECT
    *,
    CASE
      WHEN risk_score < 0.20 THEN 'LOW'
      WHEN risk_score < 0.40 THEN 'MEDIUM_LOW'
      WHEN risk_score < 0.65 THEN 'MEDIUM_HIGH'
      ELSE 'HIGH'
    END AS risk_band
  FROM population
),

-- El cluster combina poblacion y riesgo. La cantidad de ramas se mantiene
-- pequena para que el ejemplo sea facil de explicar en una demo.
cluster_assignment AS (
  SELECT
    *,
    CASE
      WHEN eligibility_error IS NOT NULL THEN NULL
      WHEN customer_population = 'RETURNING_CUSTOMER' AND risk_band = 'LOW'
        THEN 'DEMO_CLUSTER_A'
      WHEN customer_population IN ('RETURNING_CUSTOMER', 'ESTABLISHED_CUSTOMER')
        AND risk_band IN ('LOW', 'MEDIUM_LOW')
        THEN 'DEMO_CLUSTER_B'
      WHEN customer_population = 'NEW_CUSTOMER' AND risk_band = 'LOW'
        THEN 'DEMO_CLUSTER_C'
      WHEN risk_band = 'MEDIUM_HIGH' THEN 'DEMO_CLUSTER_D'
      ELSE NULL
    END AS credit_cluster
  FROM risk_segment
),

-- Parametros comerciales inventados para cada cluster.
cluster_terms AS (
  SELECT
    *,
    CASE credit_cluster
      WHEN 'DEMO_CLUSTER_A' THEN 0.35
      WHEN 'DEMO_CLUSTER_B' THEN 0.28
      WHEN 'DEMO_CLUSTER_C' THEN 0.20
      WHEN 'DEMO_CLUSTER_D' THEN 0.12
      ELSE 0
    END AS payment_to_income_ratio,
    CASE credit_cluster
      WHEN 'DEMO_CLUSTER_A' THEN 4.0
      WHEN 'DEMO_CLUSTER_B' THEN 3.0
      WHEN 'DEMO_CLUSTER_C' THEN 1.5
      WHEN 'DEMO_CLUSTER_D' THEN 1.0
      ELSE 0
    END AS income_multiplier,
    CASE credit_cluster
      WHEN 'DEMO_CLUSTER_A' THEN 25000
      WHEN 'DEMO_CLUSTER_B' THEN 18000
      WHEN 'DEMO_CLUSTER_C' THEN 8000
      WHEN 'DEMO_CLUSTER_D' THEN 4000
      ELSE 0
    END AS cluster_cap
  FROM cluster_assignment
),

-- Capacidad de pago y limite: formulas ilustrativas con valores sinteticos.
calculated_offer AS (
  SELECT
    *,
    GREATEST(
      CAST(declared_income * payment_to_income_ratio - estimated_monthly_debt AS INT64),
      0
    ) AS maximum_installment,
    GREATEST(
      LEAST(
        CAST(declared_income * income_multiplier AS INT64),
        CAST(cluster_cap AS INT64)
      ),
      0
    ) AS credit_limit
  FROM cluster_terms
),

-- Decision final resumida.
final_decision AS (
  SELECT
    *,
    CASE
      WHEN eligibility_error IS NOT NULL THEN 'REJECTED'
      WHEN credit_cluster IS NULL THEN 'REVIEW'
      WHEN maximum_installment <= 0 OR credit_limit <= 0 THEN 'REJECTED'
      ELSE 'APPROVED'
    END AS decision,
    CASE
      WHEN eligibility_error IS NOT NULL THEN eligibility_error
      WHEN credit_cluster IS NULL THEN 'DEMO_R07_MANUAL_REVIEW'
      WHEN maximum_installment <= 0 THEN 'DEMO_R08_NO_PAYMENT_CAPACITY'
      WHEN credit_limit <= 0 THEN 'DEMO_R09_NO_AVAILABLE_LIMIT'
      ELSE NULL
    END AS decision_reason
  FROM calculated_offer
)

SELECT
  customer_id,
  account_id,
  snapshot_date AS evaluation_date,
  score_source,
  customer_population,
  risk_band,
  credit_cluster,
  decision,
  CASE WHEN decision = 'APPROVED' THEN credit_limit ELSE 0 END AS credit_limit,
  CASE WHEN decision = 'APPROVED' THEN maximum_installment ELSE 0 END
    AS maximum_installment,
  decision_reason,
  recent_purchase_count AS demo_activity_count,
  recent_purchase_amount AS demo_activity_amount
FROM final_decision;
