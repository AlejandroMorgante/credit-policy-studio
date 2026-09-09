# Guía de uso del laboratorio

Credit Policy Studio separa deliberadamente **experimentación** de **producción**. Una versión puede
existir y evaluarse sin afectar a los consumidores externos. Sólo una promoción explícita cambia la
versión productiva.

## Conceptos básicos

- **Borrador:** cambios que viven en el navegador. `Aplicar cambios` actualiza el árbol visible, pero
  no crea una versión ni afecta ejecuciones externas. Si se recarga la página antes de crear una
  versión, el borrador se pierde.
- **Versión candidata:** línea de trabajo guardada para evaluación. Puede actualizarse varias veces
  sin cambiar su número; cada guardado conserva una revisión identificada por su SHA-256.
- **Versión productiva:** versión resuelta por defecto por el endpoint cuando un consumidor no pide
  una versión concreta.
- **Corrida:** una evaluación de una versión sobre un conjunto acotado del dataset. Tiene un `run_id`
  único. Cada versión conserva su lista de corridas, pero la pantalla muestra una sola a la vez y no
  suma resultados de ejecuciones distintas.

## Crear una versión

1. Abrí **Política**.
2. Seleccioná un nodo del árbol.
3. Modificá el nombre, variable, operador o umbral en el panel derecho.
4. Elegí **Aplicar al borrador**. Repetí el proceso en los nodos necesarios.
5. Elegí **Validar**. El árbol debe tener referencias válidas, campos permitidos y no contener ciclos.
6. Elegí **Guardar versión**.
7. Ingresá un identificador único, por ejemplo `2026-09-09.2`, y el responsable.

La nueva candidata queda disponible en **Versiones** y en el selector de Evaluación, pero no reemplaza
la productiva. La cabecera muestra por separado la versión de trabajo y la versión productiva actual.

Para seguir experimentando sobre esa candidata, volvé a Política, aplicá nuevos cambios y elegí
**Guardar cambios**. No se solicita otro número. **Guardar como nueva versión** queda disponible para
abrir otra línea de trabajo.

## Evaluar una versión

1. Abrí **Evaluación**.
2. En **Versión a evaluar**, elegí una candidata o la productiva. El árbol se recarga desde el JSON de
   esa versión; no reutiliza el borrador de otra.
3. Indicá la cantidad de usuarios del dataset de prueba.
4. Elegí **Iniciar evaluación**.
5. Usá **Corrida visible** para alternar entre las ejecuciones históricas de esa versión.
6. Revisá la corrida mostrada:
   - las métricas superiores pertenecen sólo al `run_id` actual;
   - cada nodo muestra cuántos usuarios llegaron a él;
   - cada rama muestra `Sí · cantidad` o `No · cantidad`;
   - los resultados conservan versión y SHA-256 para auditoría.

Volver a ejecutar reemplaza la corrida visible, pero no borra el historial persistido en BigQuery.
Si iniciás una evaluación con cambios todavía sin versionar, la aplicación solicita primero el nombre
de la nueva versión y luego abre Evaluación automáticamente.

## Promover una versión a producción

1. Evaluá la versión candidata y verificá sus resultados.
2. Elegí **Promover a productiva**.
3. Confirmá el cambio en el diálogo.

La promoción actualiza el puntero productivo y congela esa versión. No modifica corridas anteriores
ni borra otras versiones. Desde ese momento, los consumidores que omiten `policy_version` usan la
nueva productiva. Para experimentar nuevamente, creá otra candidata.

## Volver a una versión anterior

Seleccioná la versión histórica en Evaluación, comprobá nuevamente su resultado y promovela. El
rollback usa el mismo flujo explícito que cualquier otra promoción y queda separado de las corridas
históricas.

## Consultar versiones y corridas históricas

- **Versiones** muestra todas las versiones guardadas, su responsable y su estado Productiva o
  Candidata. Las candidatas aceptan nuevos guardados; la Productiva es inmutable.
- **Evaluar** abre el JSON exacto de esa versión en el laboratorio.
- **Corrida visible** enumera las corridas de la versión seleccionada y permite inspeccionarlas una a
  la vez.
- Cambiar la versión evaluada no reemplaza el borrador del editor. Al volver a Política, el workspace
  restaura los cambios y el nodo seleccionado.

## Qué sucede en Google Cloud

```text
Crear candidata → guarda el JSON de trabajo en Cloud Storage
Guardar cambios → actualiza la candidata y conserva una revisión por SHA-256
Evaluar versión → Vertex carga ese JSON, lee BigQuery y escribe un run_id nuevo
Ver resultado   → la UI consulta BigQuery filtrando por ese run_id
Promover        → congela la candidata y actualiza policies/active.json
Consumir        → Vertex resuelve policies/active.json si no se indicó otra versión
```

Todos los datos incluidos en la POC son ficticios. No deben usarse para decisiones crediticias reales.
