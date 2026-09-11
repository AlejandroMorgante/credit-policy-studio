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
2. En **Versión a editar**, elegí la política que querés usar como base.
3. Si es productiva, elegí **Crear nueva versión** e ingresá un identificador único, por ejemplo
   `2026-09-09.2`, y el responsable.
4. Seleccioná un nodo y modificá el nombre, combinación y validaciones en el panel derecho.
5. Elegí **Guardar política**. El cambio se guarda en esa candidata; repetí el proceso en los nodos
   necesarios.
6. Elegí **Validar**. El árbol debe tener referencias válidas, campos permitidos y no contener ciclos.

La nueva candidata queda disponible en **Versiones** y en el selector de Evaluación, pero no reemplaza
la productiva. La cabecera muestra por separado la versión de trabajo y la versión productiva actual.

Para seguir experimentando, dejá esa candidata seleccionada en **Versión a editar**. No se solicita
otro número por cada ajuste: **Guardar política** actualiza la misma versión. **Crear nueva versión**
queda disponible para abrir otra línea de trabajo.

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

## Agregar módulos y conectar el árbol

En una candidata editable, **+ Agregar módulo** crea una **Condición** o una **Decisión final**.
El nuevo bloque aparece sin conectar, con borde punteado. Configurá su nombre y reglas en el panel
derecho. Las decisiones finales también permiten editar el motivo del resultado.

Para conectar una condición, elegí los destinos **Si se cumple · Sí** y **Si no se cumple · No** en
el panel. También podés pulsar **Sí →** o **No →** debajo del bloque y luego pulsar el módulo de
destino en el lienzo. **Cancelar conexión** o Escape cancela esa selección. No se permiten conexiones
al propio módulo ni a un antecesor que cierre un ciclo; las decisiones finales no tienen salidas.

El botón **+ Insertar módulo en esta rama** agrega un bloque entre la condición y su destino actual.
Si insertás una condición, su rama Sí conserva ese destino y No queda pendiente. Si insertás una
decisión final, el recorrido termina allí y el antiguo destino se conserva como parte del borrador.
Podés conectarlo desde otro lugar o eliminarlo si ya no hace falta.

**Usar como inicio** cambia dónde comienza la evaluación. **Eliminar módulo** pide confirmación y
conserva los demás bloques; las ramas que llegaban al eliminado quedan pendientes. Para eliminar el
inicio hay que elegir un reemplazo, y siempre debe quedar al menos un módulo.

El lienzo distribuye automáticamente los bloques, incluidos los que todavía no están conectados.
La franja **Borrador sin guardar** enumera las ramas pendientes y los módulos que no se alcanzan desde
el inicio. **Guardar política** y **Crear nueva versión** requieren un árbol completo y sin ciclos;
la API también valida las conexiones antes de aceptar el guardado.

Los cambios permanecen en memoria mientras construís el árbol. Podés cambiar de módulo sin perder
su configuración; antes de cambiar de versión, evaluar o promover, guardá o usá **Descartar cambios**
para restaurar toda la última política guardada. Si recargás o cerrás la pestaña, el navegador avisa
cuando hay cambios pendientes; no hay recuperación automática del borrador después de cerrar.

### Deshacer y rehacer

Los botones **Deshacer** y **Rehacer**, encima del lienzo, recorren los últimos 100 cambios del
borrador: reglas, módulos, conexiones y cambio del inicio. También funcionan con **⌘Z / Ctrl+Z**
para deshacer y **⌘⇧Z / Ctrl+Shift+Z** o **Ctrl+Y** para rehacer. La escritura continua en un mismo
campo se agrupa en un paso, y se pueden deshacer valores incompletos o inválidos.

Si modificás algo después de deshacer, se descarta el camino de rehacer. Guardar correctamente,
crear otra versión, cambiar de candidata o confirmar **Descartar cambios** inicia un historial nuevo.
Un guardado fallido conserva el historial para poder corregir y reintentar. Deshacer/Rehacer no
guarda ni modifica producción y está deshabilitado en producción y Evaluación. En los diálogos,
los atajos conservan la edición de texto normal del navegador.

Para volver de una vez al árbol guardado después de desconectar módulos en el borrador, usá
**Descartar cambios** y confirmá; no hace falta reconstruir las conexiones manualmente.

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
- Cambiar la versión evaluada no cambia la **Versión a editar**. Al volver a Política, el editor
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
