# Guía de uso del laboratorio

Credit Policy Studio separa deliberadamente **experimentación** de **producción**. Una versión puede
existir y evaluarse sin afectar a los consumidores externos. Sólo una promoción explícita cambia la
versión productiva.

## Conceptos básicos

- **Versión candidata:** línea de trabajo guardada para evaluación. Puede actualizarse varias veces
  sin cambiar su número. `Guardar política` guarda el árbol completo en la candidata seleccionada y cada
  guardado conserva una revisión identificada por su SHA-256.
- **Versión productiva:** versión resuelta por defecto por el endpoint cuando un consumidor no pide
  una versión concreta. Puede inspeccionarse en Política, pero no editarse.
- **Corrida:** una evaluación de una versión sobre un conjunto acotado del dataset. Tiene un `run_id`
  único. Cada versión conserva su lista de corridas, pero la pantalla muestra una sola a la vez y no
  suma resultados de ejecuciones distintas.

## Crear una versión

1. Abrí **Política**.
2. En **Versión de la política**, elegí la política que querés usar como base.
3. Si es productiva, elegí **Crear nueva versión** e ingresá un identificador único, por ejemplo
   `2026-09-09.2`, y el responsable.
4. Seleccioná un nodo y modificá el nombre, combinación y validaciones en el panel derecho.
5. Elegí **Guardar política**. El cambio se guarda en esa candidata; repetí el proceso en los nodos
   necesarios.
6. Elegí **Validar**. El árbol debe tener referencias válidas, campos permitidos y no contener ciclos.

La nueva candidata queda disponible en **Versiones** y en el selector de Evaluación, pero no reemplaza
la productiva. La cabecera muestra por separado la versión de trabajo y la versión productiva actual.

Para seguir experimentando, dejá esa candidata seleccionada en **Versión de la política**. No se solicita
otro número por cada ajuste: **Guardar política** actualiza la misma versión. **Crear nueva versión**
queda disponible para abrir otra línea de trabajo.

## Navegar árboles grandes

- **Modo enfoque**, en la esquina superior derecha del lienzo, amplía el árbol a toda la ventana
  y oculta la navegación. Conserva la versión visible y permite abrir los detalles al elegir un
  nodo. **Salir** o **Escape** restaura la vista de trabajo.
- La lupa del lienzo o **⌘K / Ctrl+K** abre la búsqueda por nombre, variable o tipo de nodo.
  Elegir un resultado abre sus detalles y lo centra a tamaño legible.
- El **minimapa** muestra la ubicación de la vista y el nodo seleccionado. Hacé clic para moverte
  a otra parte del árbol.
- **Encuadrar árbol completo** muestra todos los nodos, incluso en políticas grandes.
  **Centrar nodo seleccionado** vuelve al nodo que estás inspeccionando.
- Los botones **− / +** cambian el zoom; el porcentaje lo restablece al **100%**.
- Arrastrá el fondo para moverte. Con el foco en el lienzo, también podés usar las flechas,
  **+ / −**, **0** para encuadrar y **F** para centrar la selección.
- El botón de panel en la esquina superior derecha permite ocultar los detalles y ampliar el
  lienzo. Seleccionar un nodo vuelve a abrir sus detalles.

## Ordenar y editar cajas

Hacé clic en una caja para ver sus detalles; mantené el clic y arrastrá para reubicarla. Las líneas
siguen sus conexiones. Esta distribución se recuerda por versión en tu navegador y no cambia las
reglas ni se comparte con otros usuarios. **Distribuir cajas automáticamente** recupera la distribución inicial;
**Deshacer movimiento** restaura la distribución anterior al último movimiento o reordenamiento.

El pie del panel muestra **Guardado** o **Borrador sin guardar**. Podés cambiar de nodo sin
perder sus campos; **Guardar política** guarda todos los cambios juntos cuando el árbol esté
completo. Al cambiar de versión o vista, podés guardar, descartar el borrador completo o seguir
editando. Un guardado fallido conserva los cambios y el historial.

## Agregar módulos y conectar el árbol

**+ Nodo** permite agregar una condición o resultado sin conectar, insertarlo en una rama Sí/No,
o insertar una condición **antes de este nodo**. Esta última opción redirige todas las entradas
del nodo seleccionado y cambia el inicio si corresponde. La rama Sí conserva el recorrido anterior;
para No podés elegir un destino existente, crear un resultado o dejarla pendiente.

Desde las filas **Sí** y **No** del inspector podés ir al destino, cambiarlo o insertar un nodo.
También podés pulsar **Sí → / No →** debajo de una caja y luego elegir el destino en el lienzo;
**Cancelar conexión** o Escape cancela la operación. Los destinos que crearían ciclos no se ofrecen.
Las decisiones finales no tienen salidas.

Reconectar o insertar una decisión no elimina otros módulos: los que queden fuera del recorrido
se conservan con borde punteado. **Usar como inicio** cambia el punto de entrada. **Eliminar módulo**
pide confirmación, conserva los descendientes y deja pendientes las ramas que llegaban al eliminado.
Para eliminar el inicio hay que elegir otro; siempre debe quedar al menos un módulo.

La franja del borrador enumera módulos sin conectar y ramas pendientes. **Guardar política**,
**Validar** y **Crear nueva versión** requieren un árbol completo, alcanzable desde el inicio y sin
ciclos. La API también comprueba estas restricciones. Producción y Evaluación son de sólo lectura.

### Deshacer y rehacer

**Deshacer / Rehacer** recorre hasta 100 cambios del borrador: reglas, altas, eliminaciones,
conexiones y cambio del inicio. Atajos: **⌘Z / Ctrl+Z** para deshacer y **⌘⇧Z / Ctrl+Shift+Z**
o **Ctrl+Y** para rehacer. La escritura continua en un campo cuenta como un paso; también podés
deshacer valores incompletos o inválidos. Una nueva edición descarta el camino de rehacer.

Guardar correctamente, crear o abrir otra versión o confirmar **Descartar cambios** reinicia
el historial. Deshacer/Rehacer no hace peticiones de guardado. Está separado de **Deshacer
movimiento de cajas**, que sólo restaura posiciones visuales y no cambia reglas ni conexiones.

El borrador y su historial viven en memoria. **Descartar cambios** recupera toda la última política
guardada, incluidas sus conexiones. El navegador avisa antes de cerrar o recargar con cambios;
no hay recuperación automática del borrador después de cerrar. En los diálogos, los atajos de
edición de texto siguen siendo los propios del navegador.

## Combinar validaciones en una condición

Cada condición tiene un **Nombre visible** y un **Tipo de combinación**:

- **Sin combinación:** exactamente una validación; no permite agregar otra.
- **AND:** la rama Sí se toma cuando se cumplen todas las validaciones.
- **OR:** la rama Sí se toma cuando se cumple al menos una validación.

Cada validación tiene variable, operador, umbral y **Eliminar validación**. Usá
**+ Agregar validación** para sumar reglas con la combinación elegida. Siempre debe quedar al menos
una validación. Para volver a **Sin combinación**, eliminá las adicionales primero.

Los operadores **Es nulo** y **Tiene valor** usan un umbral **Sí / No**. Por ejemplo, para exigir
que exista un score de buró y que sea mayor a 650, seleccioná **AND** y configurá:

1. Score de buró · Tiene valor · Sí.
2. Score de buró · Mayor que · 650.

**Es nulo · No** equivale a **Tiene valor · Sí**, y **Tiene valor · No** equivale a
**Es nulo · Sí**. Cero es un valor presente. Los datos ausentes o `null` se consideran nulos;
las comparaciones ordinarias sobre ellos dan falso, incluso **Distinto**. Así, el resultado no
depende de poner la validación de nulidad antes o después de la comparación numérica.

**Está en la lista** acepta un arreglo JSON como umbral, por ejemplo `[600, 700, 800]`.
**Guardar política** guarda todas las validaciones juntas. La versión productiva y el laboratorio
de evaluación muestran estos controles en modo de sólo lectura.

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
Al abrir Evaluación desde Política, la candidata que estabas editando queda seleccionada por defecto.

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
- **Editar** abre una candidata en Política. **Ver** abre la productiva en modo de sólo lectura.
- Cambiar la versión evaluada no cambia la **Versión de la política** del editor. Al volver a Política, el editor
  restaura esa versión y el nodo seleccionado.

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
