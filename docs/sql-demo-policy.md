# Política SQL adaptada para localhost

La candidata **sql-demo-2026-09-10.1** se genera a partir de
[`sql/example_policy.sql`](../sql/example_policy.sql). Su definición reproducible está en
[`policies/credit_policy_sql_demo.json`](../policies/credit_policy_sql_demo.json).
Usa exclusivamente los nodos `condition` y `decision` actuales. No requiere nuevas variables,
operadores, expresiones ni asignaciones durante la evaluación.

## Probarla

1. Abrí <http://localhost:8080> y recargá la página.
2. En **Versión a editar**, seleccioná **sql-demo-2026-09-10.1 · Candidata**.
3. El primer bloque permite probar **AND**, ingreso presente e ingreso mínimo. El siguiente usa
   **OR** para admitir un score de comportamiento o de buró.
4. Aplicá cambios y abrí **Evaluación** para ejecutar esa candidata sobre el dataset local.
5. Para recorrer el árbol completo, usá el zoom y arrastrá el lienzo.

La productiva original queda intacta. La candidata puede editarse y evaluarse sin promoverla.

## Adaptaciones respecto del SQL

| SQL | Demo ejecutable |
| --- | --- |
| `declared_income` | `variable_1`: ingreso mensual; conserva presencia y mínimo de 1.000. |
| `estimated_monthly_debt` | `variable_2`: deuda mensual. Se exige valor presente y no negativo. |
| Score de comportamiento prioritario | `score_3`; aproximación de riesgo `(100 - score_3) / 100`. |
| Score de solicitud alternativo | `score_1` de buró; aproximación de riesgo `(850 - score_1) / 550`, sólo si falta `score_3`. |
| Población por préstamos completados y antigüedad de cuenta | Aproximación por antigüedad **laboral**, `variable_3`: ≥24 meses para A, ≥4 para B, menor o ausente para C si el riesgo es bajo. No identifica clientes recurrentes reales. |
| Filtros de restricciones, default, edad y días de mora | Omitidos: el contrato actual no contiene esos datos. |
| Validación de versión de modelo, cuenta, fecha y actividad | Omitida: esos campos tampoco están disponibles. |
| Oferta calculada para cada persona | Oferta fija y control de deuda por tramo de ingreso, descritos abajo. |

`score_2` se conserva en el dataset, pero esta política no agrega un filtro de capacidad basado en ese
score que no figura en el SQL. Las escalas de riesgo son aproximaciones de demo, no probabilidades
calibradas. Los límites estrictos del SQL se traducen a `score_3 > 80 / 60 / 35` y
`score_1 > 740 / 630 / 492.5` para riesgo bajo, medio bajo y medio alto, respectivamente.

Se conserva el orden de asignación A → B → C → D. El riesgo alto y los casos de riesgo medio bajo
sin antigüedad suficiente van a revisión. En las hojas aprobadas, `risk_band` identifica el cluster
comercial A/B/C/D; `reason_code` también identifica el tramo. No se agregan campos de salida nuevos.

## Oferta por tramos

Los nodos actuales comparan una variable contra un umbral y devuelven límites fijos. Para aproximar
las fórmulas del SQL se toma el mayor piso de ingreso alcanzado dentro de cada cluster:

| Cluster | Ratio cuota/ingreso | Multiplicador | Piso base | Piso intermedio | Piso para tope | Tope |
| --- | --- | --- | --- | --- | --- | --- |
| A | 0,35 | 4 | 1.000 | 3.000 | 6.250 | 25.000 |
| B | 0,28 | 3 | 1.000 | 3.000 | 6.000 | 18.000 |
| C | 0,20 | 1,5 | 1.000 | 3.000 | 5.333,34 | 8.000 |
| D | 0,12 | 1 | 1.000 | 3.000 | 4.000 | 4.000 |

El límite fijo es `min(piso × multiplicador, tope)` y la deuda máxima del tramo es
`floor(piso × ratio - 1)`. Estos números están precalculados en el JSON: el motor no ejecuta fórmulas.
Es una aproximación conservadora: puede ofrecer menos o rechazar un caso que el cálculo individual
del SQL aceptaría. No produce `maximum_installment`; sólo valida que la deuda deje margen positivo
según el piso del tramo. Los límites aprobados son siempre positivos, por lo que no hace falta una
rama adicional para el motivo R09.

Sobre los ocho usuarios locales originales se esperan **2 aprobados y 6 rechazados**. Otros datos
pueden alcanzar la revisión manual, los otros clusters y los tramos base.

## Recuperación de la candidata anterior

El archivo local `Demo Lucho.json` tenía un formato incompatible (`conditions`, `combinator`,
expresiones y asignaciones), lo que impedía listar cualquier versión. Se conserva íntegro en
`.local/policies/.incompatible/Demo Lucho.json`; sus revisiones anteriores permanecen en
`.local/policies/.revisions/Demo Lucho/`. No se convirtió ni se sobrescribió ese contenido.
