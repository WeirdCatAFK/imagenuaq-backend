# Datamodel

El diccionario de datos —las 38 tablas y la vista, columna por columna— está en §7. Lo de
antes es el porqué: §1 la forma general, §2 las decisiones caras de revertir, §3 la
trazabilidad contra los requerimientos, §5 los huecos ya cerrados y §6 lo que falta.

Los identificadores (tablas, columnas, valores de catálogo) van en inglés, como el resto
del código; la prosa de este documento va en español, como el resto de la documentación de
dominio. Cada decisión cita el requerimiento que la obliga: los IDs `RF-*` vienen de
`../docs/Requerimientos funcionales.docx`.

## Estado

| Módulo                           | Tablas                                                                                                                                                                                                                                   | Estado                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| USR                               | `users`, `roles`, `areas`, `area_hierarchy`, `area_members`, `contract_types`, `permissions`, `role_permissions`                                                                                                         | Implementado                                                                         |
| CAL / AUS                         | `events`, `event_types`, `event_participants`, `event_exceptions`, `event_collections`, `collection_events`, `absences`, `absence_types`, `contract_type_entitlements`, `leave_balances`, `absence_status_history` | Implementado;`contract_type_entitlements` aún sin topes (§5.4)                   |
| ARC                               | `folders`, `files`, `file_locations`, `storage_volumes`, `folder_areas`, `access_tokens`                                                                                                                                     | Implementado                                                                         |
| —                                | `logs`, `actions`                                                                                                                                                                                                                    | Implementado                                                                         |
| SOL / PRY / EST                   | `entities`, `entity_contacts`, `schemas`, `schema_versions`, `sheets`, `requests`, `projects`, `statuses`                                                                                        | Implementado por`projects-spine`; falta la definición de formatos por UI            |
| FLW                               | `project_stages`, `approvals`, `project_field_values`                                                                                                                                                             | Parcial: las etapas se instancian a mano; falta el editor por nodos (§6)            |
| TSK                               | —                                                                                                                                                                                                                                       | Sin modelar; cuelga de`projects` y `project_stages` (§6)                          |
| FIN, INV, IMP, RPT, EXT           | —                                                                                                                                                                                                                                       | Sin modelar; §4 describe los puntos de enganche                                     |

La migración `projects-spine` aterrizó la columna vertebral del MVP: once tablas que
alcanzan para que una solicitud entre con folio, caiga en la bandeja de un área, se
convierta en proyecto y pase por etapas con visto bueno. Lo que quedó fuera es la mitad
*declarativa* de FLW y todo TSK, y §6 dice cómo entran sin volver a mover lo que ya está.

La forma autoritativa es `dbml/current.dbml`, que `scripts/genDBML.js` regenera después de
cada migración. Los `.dbml` escritos a mano que sirvieron de propuesta vivían en
`docs/design/` del directorio contenedor `ImagenUAQ/`, **fuera de este repositorio**; ya no
son la referencia de nada implementado, y quien clone solo `imagenuaq-backend` nunca los
tuvo. Este documento es lo que queda de ellos.

## 1. La columna vertebral

Cinco módulos que se leen como una sola cadena, y de los que cuelgan todos los demás:

```
schemas → schema_versions ─┬─ sheets                     (RF-MIG-01: el Excel sigue vivo)
                           │
entities ─┬─ requests ─────┴──→ projects ─┬─ project_stages ──→ approvals
          │   (data JSONB)                ├─ project_field_values
          └─ entity_contacts              └─ tasks / notes / time_entries   (sin modelar)

statuses  (catálogo por área; projects.status_id, requests.status_id)

workflows → workflow_versions → workflow_stages ⇄ workflow_transitions   (grafo, §6)
```

Una solicitud entra por un formato (`schema_versions`), recibe folio y cae en la bandeja
del área (`RF-SOL-03`, `RF-SOL-04`). Una o varias solicitudes se convierten en proyecto
(`RF-PRY-01`). El proyecto pasa por etapas: cada una es una fila en `project_stages`, y
cada visto bueno una fila en `approvals` (`RF-FLW-03`, `RF-PRY-03`). Las tareas colgarán
del proyecto y, opcionalmente, de la etapa.

Todo lo anterior existe salvo la última línea del diagrama: las etapas se crean hoy a
mano, porque `workflows` y sus versiones son la mitad de FLW que no se migró (§6). Nada de
lo que ya está cambia cuando entren — `project_stages` gana `workflow_stage_id` y el resto
queda igual.

## 2. Decisiones de diseño

Las que cambian la forma del esquema y son caras de revertir después.

### 2.1 El flujo es un grafo, no una lista ordenada

`RF-FLW-09` permite que un mismo proyecto derive en trabajo **simultáneo** para más de un
área, y `RF-FLW-02` pide armarlo en una interfaz por nodos. Una columna `orden int` sobre
las etapas no puede expresar una bifurcación ni una reunión de ramas.

Por eso `workflow_stages` son nodos y `workflow_transitions` son aristas. El editor guarda
la posición de cada nodo (`position_x`, `position_y`) para que el diagrama sobreviva al
guardado.

**Consecuencia:** `projects` **no** lleva `current_stage_id`. Con ramas paralelas no hay
una etapa actual sino varias; la etapa actual es el conjunto de filas de `project_stages`
con `status = 'active'`. Poner esa columna es el error que obliga a rehacer el módulo
cuando aparece el primer proyecto que va a diseño e imprenta a la vez.

**Implementado así.** `projects-spine` creó `project_stages` sin `workflow_stage_id` —los
nodos aún no existen— y sin puntero alguno en `projects`. La tabla lleva `seq`, que es
orden de presentación y nada más: `project_stages.seq` no decide qué sigue, y el comentario
de la columna lo dice para que no se relea como el contador que esta sección rechaza.

### 2.2 Formatos y flujos se versionan; las versiones publicadas son inmutables

`RF-SOL-01` y `RF-FLW-02` piden que coordinación dé de alta formatos y flujos sin
desarrollo. Si esas definiciones se editan en su lugar, dos cosas se rompen: una solicitud
vieja deja de poder mostrarse con los campos con los que se capturó, y un proyecto en
vuelo cambia de flujo a media ejecución.

Por eso `schemas → schema_versions` y `workflows → workflow_versions → workflow_stages`.
Editar publica una versión nueva; `requests.schema_version_id` y
`projects.schema_version_id` apuntan a la versión con la que nacieron y nunca se mueven.

Las tablas se llaman `schemas` y `schema_versions`, no `forms` y `form_versions`: el mismo
objeto describe el formato de captura **y** el destino de una importación de Excel
(`sheets.schema_version_id`, §2.9), y llamarlo formato dejaría el segundo uso sin nombre.
El costo del nombre es que "schema" ya significa otra cosa en Postgres; se aceptó porque
ninguna de las dos acepciones aparece en las consultas de la otra.

**La inmutabilidad es un trigger, no una convención.** `schema_versions_immutable` rechaza
todo `UPDATE` sobre la tabla. Dejarla en la orquestación es dejarla al cuidado del próximo
que escriba un `UPDATE`, y para cuando se note, la historia que protege ya se reescribió.
Es el mismo criterio que `folders_no_cycle`.

### 2.3 El payload de la solicitud es JSONB; los campos que se buscan son columnas

`RF-SOL-06` exige conservar **todo** lo capturado, incluidos los campos que después ocupa
facturación. `RF-SOL-05` exige buscar por nombre, entidad, folio, responsable y estatus.

Las dos cosas no quieren el mismo almacenamiento:

- `requests.data jsonb` guarda la captura completa, sea cual sea el formato. Un modelo EAV
  (`request_field_values`) daría lo mismo con un join por campo y sin ganar nada: nadie
  consulta un campo suelto de un formato arbitrario.
- Lo que `RF-SOL-05` busca sube a columnas reales (`folio`, `title`, `entity_id`,
  `status_id`, `assignee_id`). Son las mismas para todos los formatos, así que no
  dependen de la definición dinámica.
- La definición de los campos vive en `schema_versions.fields jsonb`, un arreglo ordenado.

**Esto último invierte lo que esta sección decía.** El argumento original era que los
campos debían ser filas (`form_fields`) porque el constructor de formatos y el validador
los consultan y los ordenan. Los consultan, sí, pero **de una versión a la vez**, que es
una sola lectura en JSONB; y nada busca a través de las definiciones de formatos
distintos, que es lo único que las filas comprarían. El orden, que era el otro motivo, lo
da el índice del arreglo sin una columna `sort_order`.

Las filas vuelven el día que algo consulte campos entre formatos —un reporte de "qué
formatos piden tiraje", por ejemplo—. Mientras tanto, el `CHECK jsonb_typeof(fields) =
'array'` es lo que impide que la columna degenere en un objeto suelto.

### 2.4 Los valores que cruzan etapas son filas, no un JSONB acumulado

`RF-FLW-06` es explícito: el número de orden que genera diseño debe aparecer en el
registro de facturación de imprenta sin recaptura. `RF-IMP-08` lo repite desde el otro
lado.

`project_field_values(project_id, key, value, produced_by_stage_id)` guarda esos valores
como filas porque, a diferencia del payload de la solicitud, **otros módulos los buscan**
(imprenta busca por número de orden) y `RF-PRY-03` quiere saber qué etapa los produjo. Un
`projects.data jsonb` mutable perdería la procedencia y obligaría a un índice GIN para lo
que aquí es una búsqueda por igualdad.

### 2.5 El formato enruta a través del flujo, no por su cuenta

`RF-SOL-02` pide que cada formato esté asociado al área a la que se dirigen sus
solicitudes (el formato 02, papel institucional, cae primero a diseño gráfico).

En vez de una tabla de áreas destino en paralelo, `schema_versions.workflow_version_id`
apunta al flujo, y las etapas marcadas `is_entry` definen a qué áreas cae. Un solo lugar
decide el enrutamiento, que es también lo que `RF-FLW-04` automatiza al dar el visto bueno.
Es la misma lección de la migración `schema-proofing`: la jefatura de área estaba en tres
lugares y ninguno los mantenía de acuerdo.

**Revisable.** Si aparece un formato que debe existir sin flujo, la salida es permitir
`workflow_version_id` nulo más un área de destino explícita, no reintroducir la tabla
paralela.

**Pendiente, con un puente.** `schema_versions` todavía no apunta a ningún flujo, porque
los flujos no existen. Mientras tanto el enrutamiento lo lleva `requests.area_id`: la
bandeja en la que la solicitud cayó, escrita al crearla. Es exactamente el "área de destino
explícita" del párrafo anterior, así que cuando entre FLW la columna no estorba —pasa a ser
el valor derivado de la etapa de entrada, y el único cambio es quién la escribe.

### 2.6 Las etapas se pueden repetir

Un visto bueno rechazado devuelve el trabajo a diseño. Por eso `project_stages` no es
única por `(project_id, workflow_stage_id)` sino por `(project_id, workflow_stage_id, attempt)`. Sin el contador, el reproceso o sobrescribe la historia o falla al insertar —
y `RF-PRY-03` pide justamente esa historia.

Sin nodos todavía, la clave implementada es `(project_id, area_id, seq, attempt)`: `seq`
ocupa el lugar del nodo para distinguir dos etapas de la misma área —propuesta y luego
ajustes— sin abusar de `attempt`, que significa otra cosa. Cuando entren los nodos, el
índice se mueve a `workflow_stage_id` y `seq` queda como lo que ya es, orden de
presentación.

### 2.7 El historial de estatus se registra en `logs`, no en una tabla propia

`RF-USR-07` ya pide bitácora de quién creó, modificó o eliminó cada registro relevante.
Una `status_history` aparte sería un segundo mecanismo de auditoría para un caso
particular. `logs` ya tiene objeto (§5.3), así que los cambios de estatus son entradas
suyas.

Los vistos buenos **sí** son tabla propia (`approvals`): `RF-FLW-03` y `RF-FLW-05` los
tratan como un objeto de negocio con decisión, comentario y firmante, no como una traza.

**Y las ausencias también**, en `absence_status_history`, que es una excepción deliberada a
la regla de arriba. El motivo no es de forma sino de confidencialidad: `RF-AUS-13` restringe
quién puede ver el detalle de un permiso, y llevar ese rastro a la bitácora general
obligaría a que toda consulta contra `logs` recordara excluir `target_table = 'absences'`
para no filtrarlo. Mantener lo restringido dentro de las tablas `absence_*` deja una
frontera contigua que vigilar, en vez de un filtro que recordar.

Para las alertas de `RF-EST-03` y `RF-EST-04` ("lleva demasiado tiempo en el mismo
estatus") se desnormaliza `status_since` en la fila. Recorrer la bitácora para contestar
eso en cada consulta del tablero no escala, y el valor es reconstruible desde `logs` si
llega a divergir. Está implementado en `projects` y en `requests`; quien mueva
`status_id` tiene que mover `status_since` en el mismo `UPDATE`, y eso es regla de
orquestación, no del esquema.

Ojo con el nombre: `project_stages.status` **no** es un `status_id` del catálogo. Es la
máquina del flujo (`pending`, `active`, `waiting_external`, `done`, `cancelled`) y contesta
si el área puede trabajar; `statuses` contesta qué muestra el tablero (`RF-EST-01`). Son dos
preguntas distintas y por eso son dos columnas en dos tablas.

### 2.8 La solicitud no es un proyecto temprano

Es la fusión que casi todo borrador hace, y la que más cuesta deshacer. `RF-SOL-03` le da
folio a la solicitud **en cuanto entra**, antes de que nadie decida que es trabajo;
`RF-SOL-04` la pone en la bandeja del área; `RF-PRY-01` convierte **una o varias** en un
proyecto. Con una sola tabla, la solicitud rechazada no tiene dónde vivir y el proyecto que
nació de tres se queda con una.

Por eso `requests` y `projects` son tablas distintas y la relación va del lado de la
solicitud: `requests.project_id` nulo es una solicitud sin convertir, que es justo lo que
la bandeja consulta. Muchas a uno es la dirección que `RF-PRY-01` enuncia y la contraria no
tiene caso, así que no hay tabla puente.

**El folio lo genera la base.** `requests.folio` tiene `DEFAULT` sobre la secuencia
`requests_folio_seq`. Calcularlo en la orquestación con un `max() + 1` produce el mismo
folio dos veces exactamente cuando dos solicitudes entran a la vez, y `RF-SOL-03` pide un
identificador único. Reiniciarlo por año es cambiar la expresión del `DEFAULT`, no la
forma.

### 2.9 El Excel sigue vivo, y el sistema sabe cuál

`RF-MIG-01` no pide importar y olvidar: pide que las respuestas queden en la base
**mientras** el Excel actual se sigue usando, y `RF-MIG-02` pide poder traer lo que ya
existe. `src/routes/spreadsheets.js` ya lee un libro por Graph; lo que no tenía era dónde
anotar cuál libro, mapeado cómo, hacia qué formato.

`sheets` es ese registro. Tres decisiones dentro:

- **`drive_id` + `item_id`, no la URL.** Es el par que toman las llamadas a Graph; un
  enlace compartido ni sobrevive a que muevan el archivo ni identifica una tabla dentro
  del libro. `web_url` se guarda igual, porque es lo que un humano pega, pero es adorno.
- **`column_map` apunta a un `schema_version_id`, no a un `schema_id`.** Un mapeo se
  escribe contra las columnas de una versión concreta; apuntar a la identidad móvil lo
  desalinearía en silencio el día que el formato gane un campo. Reapuntarlo tras publicar
  una versión nueva es un acto deliberado, que es el costo correcto.
- **`last_imported_at`**, para que una importación periódica sepa desde dónde seguir en vez
  de releer el libro entero.

`requests.source = 'sheet'` es el otro extremo del hilo, y el `CHECK requests_sheet_origin`
impide que una solicitud capturada a mano diga venir de un libro.

## 3. Trazabilidad

La columna **Estado** dice si la tabla citada existe hoy: ✔ implementado, ◑ parcial,
✗ la tabla aún no está creada.

| RF                              | Cubierto por                                                                                                        | Estado |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------ |
| RF-SOL-01                       | `schemas`, `schema_versions.fields` (§2.2, §2.3)                                                             | ◑ falta la UI de armado |
| RF-SOL-02                       | `requests.area_id` como puente; después`schema_versions` → flujo (§2.5)                                     | ◑ |
| RF-SOL-03                       | `requests.folio`, de la secuencia`requests_folio_seq` (§2.8)                                                   | ✔ |
| RF-SOL-04, RF-SOL-05            | Columnas promovidas de`requests` + `idx_requests_inbox` (§2.3)                                                 | ✔ |
| RF-SOL-06                       | `requests.data`, `requests.folder_id`                                                                           | ✔ |
| RF-SOL-07                       | `entities`, `entity_contacts`                                                                                   | ✔ |
| RF-SOL-08                       | `requests.source`                                                                                                 | ✔ |
| RF-PRY-01                       | `requests.project_id` (§2.8)                                                                                      | ✔ |
| RF-PRY-02                       | `projects`, `project_members`; las áreas participantes se derivan, no se guardan                               | ◑ falta`project_members` |
| RF-PRY-03                       | `project_stages` + `approvals` + `logs`                                                                       | ✔ |
| RF-PRY-04                       | `time_entries`                                                                                                    | ✗ |
| RF-PRY-05                       | `notes.kind`                                                                                                      | ✗ |
| RF-PRY-06                       | `workflows` reutilizables; sin estructura nueva por eventualidad                                                  | ✗ |
| RF-PRY-07                       | `projects.has_cost`                                                                                               | ✔ |
| RF-PRY-08                       | `projects.carried_over`; `period_id` espera a`periods` (CAL/FIN)                                            | ◑ |
| RF-PRY-09                       | `project_materials.origin`                                                                                        | ✗ |
| RF-FLW-01, RF-FLW-02            | `workflow_stages` + `workflow_transitions` (§2.1, §6)                                                        | ✗ etapas a mano |
| RF-FLW-03                       | `approvals`                                                                                                       | ✔ |
| RF-FLW-04                       | `workflow_transitions` + `notifications`                                                                        | ✗ |
| RF-FLW-05                       | `approvals.approver_contact_id`, una fila por lado                                                                | ◑ falta`requires_entity_approval`, que es del flujo |
| RF-FLW-06                       | `project_field_values` (§2.4)                                                                                    | ✔ |
| RF-FLW-07                       | `project_stages.status = 'waiting_external'` + `blocked_reason` (CHECK)                                        | ✔ |
| RF-FLW-08                       | `projects.priority`, `requests.priority`; sin orden por fecha de llegada                                        | ✔ |
| RF-FLW-09                       | Sin etapa actual: el conjunto de`project_stages` activas (§2.1)                                                 | ✔ |
| RF-TSK-01 … RF-TSK-05          | `tasks`; hoy solo`project_stages.assigned_to`, una persona por etapa                                          | ◑ |
| RF-TSK-06, RF-TSK-07            | Consulta sobre`events` + `area_members`; sin tabla nueva                                                        | ✔ |
| RF-EST-01                       | `projects.status_id` → `statuses`                                                                              | ✔ |
| RF-EST-02                       | `statuses.area_id`; el catálogo global viene sembrado, los de área los pone coordinación                       | ✔ |
| RF-EST-03, RF-EST-04, RF-EST-09 | `alert_rules` + `status_since`                                                                                  | ◑ `status_since` sí, `alert_rules` no |
| RF-EST-05                       | Sin tabla: regla de orquestación sobre`expected_invoice_count`, las etapas sin `approvals` y la evidencia      | ◑ |
| RF-EST-06, RF-EST-10            | `notifications`                                                                                                   | ✗ |
| RF-EST-07, RF-EST-08            | Consulta sobre`projects` + `status_since` + `idx_projects_open`                                              | ✔ |
| RF-MIG-01, RF-MIG-02            | `sheets` + `requests.data` (§2.9)                                                                              | ✔ |
| RF-MIG-04                       | `project_field_values` con la clave del folio externo (`folio_sin`)                                             | ✔ |
| RF-CAL-03                       | `period_closures` + `projects.has_cost`                                                                         | ◑ |
| RF-USR-01, RF-USR-02            | `users`, `areas`, `area_members`, `roles`                                                                   | ✔ |
| RF-USR-03, RF-USR-04            | `area_members` + `area_hierarchy` (§5.5): el área propia y, recorriendo el árbol, todo lo que cuelga de ella | ✔ |
| RF-USR-05, RF-USR-10            | `permissions` + `role_permissions` (§5.2)                                                                      | ✔ |
| RF-USR-07                       | `logs` con `target_table`/`target_id` (§5.3)                                                                 | ✔ |
| RF-USR-09                       | `areas` + `area_hierarchy` (§5.5): un área y una coordinación son la misma tabla                             | ✔ |

`RF-TSK-07` y `RF-CAL-06` cruzan con ausencias: la ocupación del área debe descontar las
ausencias autorizadas. Se resuelven leyendo `events` (público) y **nunca** `absences`
(restringido) — la misma frontera que obliga a que la notificación de `RF-EST-10` lleve
fechas y duración pero nunca el motivo.

## 4. Puntos de enganche de los módulos restantes

Lo que la columna vertebral deja preparado, para no rediseñarla al llegar a ellos. Desde
`projects-spine`, los enganches marcados existen de verdad y no son promesas:

- **FIN** — `entities` (existe) como destinatario del cobro y `project_field_values`
  (existe) para el número de orden que `RF-IMP-08` pasa a facturación imprenta. Faltan
  `projects.expected_invoice_count`, `providers`, `quotes`, `invoices`, `oficios`,
  `payments`. Ojo con §5.6: el despachador de eventos deja que una escritura tenga éxito
  sin su fila de bitácora, y para FIN la forma que no puede perder una es un CTE que
  escriba en `logs` en la misma sentencia que el cambio.
- **INV** — independiente del proyecto salvo por préstamos ligados a uno. Faltan
  `inventory_items`, `inventory_loans`, `inventory_movements`, y para `RF-INV-07` las
  licencias compartidas con su bitácora de sesiones.
- **IMP** — `print_orders` cuelga de `projects`; los pantones por facultad cuelgan de
  `entities` (`RF-IMP-06`).
- **EXT** — `entity_contacts` ya es la identidad del externo y `access_tokens` ya da
  compartición de solo lectura (`RF-ARC-03`, `RF-EXT-03`). Falta el token de portal para
  `RF-EXT-01`.
- **RPT** — sin tablas: son consultas. `RF-RPT-02` (carga por persona) sale de
  `project_members` y `time_entries`; `RF-RPT-03` de `status_since`.

## 5. Huecos en el modelo ya implementado

Independientes de la columna vertebral, y encontrados al contrastar el esquema vigente con
los requerimientos. **Los primeros cuatro se cerraron en `I0-dbFixes`**, una migración por hueco para
que el rollback fuera granular:

El diagnóstico se conserva abajo porque explica por qué el esquema quedó como quedó.

### 5.1 Los saldos de días no tenían dimensión de tipo — cerrado

`contract_types.annual_offdays` era un entero y `days_off` una fila por usuario y año.
Eso no alcanzaba para:

- `RF-AUS-03` — catálogo de **tipos** de ausencia configurable desde la aplicación (nombre,
  unidad de conteo, tope, vigencia, si descuenta saldo). No existe `absence_types`, así que
  `RF-AUS-09` (días institucionales que no descuentan) no se puede ni expresar.
- `RF-AUS-04` — los topes pertenecen a (esquema de contratación × tipo × **vigencia**), y
  cambiarlos **no debe reescribir el histórico ya consumido**. Un entero mutable sobre
  `contract_types` hace exactamente lo que el requerimiento prohíbe.
- `RF-AUS-05` — las excepciones individuales (días por antigüedad en el esquema
  sindicalizado) solo se pueden sobrescribir para la bolsa global, no por tipo.
- `RF-AUS-14` — el permiso necesita estatus propio (solicitado, autorizado, rechazado,
  cancelado, gozado) con fecha y usuario en cada cambio. `absences` solo tiene
  `approved_by`/`approved_at`: rechazado y cancelado son irrepresentables, y `RF-AUS-06`
  pide reponer el saldo al cancelar.

**Cómo se cerró.** `absence_types` es el catálogo configurable de `RF-AUS-03`, con
`consumes_balance` para los días institucionales de `RF-AUS-09`.
`contract_type_entitlements` mueve el tope a (esquema × tipo × vigencia): cambiarlo cierra
la fila vigente con `valid_to` e inserta otra, nunca hace `UPDATE amount`, que es lo que
`RF-AUS-04` prohíbe. Una restricción `EXCLUDE` impide que dos vigencias se traslapen y
vuelvan ambiguo el tope de una fecha. `leave_balances` reemplaza a `days_off` con
dimensión de tipo, y su `granted` es la excepción individual de `RF-AUS-05`. `absences`
gana `absence_type_id` y `status`, y `absence_status_history` guarda usuario y fecha de
cada cambio (`RF-AUS-14`).

La pregunta del ciclo — año calendario o aniversario de contratación, que para el esquema
sindicalizado no coinciden — dejó de ser de modelo: `leave_balances` guarda
`cycle_start`/`cycle_end` como fechas, así que cualquiera de los dos se siembra sin otra
migración. **Sigue pendiente decidirlo con control de personal**, pero ya no bloquea el
esquema.

Consecuencia de mantener `absences.event_id` como PK: como el permiso crea su evento desde
que se solicita, `events` por sí solo sobre-reporta ausencias. La vista
`absence_availability` filtra por `status IN ('approved','taken')` y expone fechas, persona
y área sin `reason` ni `document_file_id`. **Es lo que deben leer `RF-TSK-06`, `RF-TSK-07`,
`RF-CAL-05` y `RF-CAL-06`**, y de donde sale la notificación de `RF-EST-10` con fechas y
duración pero sin motivo.

### 5.2 No había dónde guardar un permiso — cerrado

`users.role_id → roles.name` era todo el modelo. `RF-USR-05` (lectura y edición
independientes, asignables por rol) y `RF-USR-10` (ver el motivo de una ausencia es un
permiso distinto de ver la disponibilidad) vivían solo en código.

**Cómo se cerró.** `permissions` y `role_permissions`, con el catálogo sembrado en la
migración porque los códigos son el requerimiento hecho dato. `project.read` y
`project.write` son dos filas y no dos niveles de una: un `level` ordenado no podría
expresar `finance.read` de `RF-USR-08`, que es lectura transversal sin escritura en ningún
lado. `availability.read` y `absence.reason.read` separados son literalmente `RF-USR-10`, y
que existan como dos filas es lo que impide colapsarlos al implementar.

**El rol se queda global — decidido, no pendiente.** Durante un tiempo esta sección dejó
abierto mover `role_id` a `area_members`, para que alguien pudiera tener un rol distinto en
cada área. Se descartó. El rol dice **qué puede hacer** una persona y el área dice **sobre
qué registros**, y son dos preguntas separadas:

- `RF-USR-05` —qué puede hacer— la contesta `role_permissions`, y no cambia de un área a
  otra: quien puede editar proyectos, puede editar proyectos.
- `RF-USR-03` y `RF-USR-04` —sobre qué registros— las contesta `area_members`, cruzada con
  `area_hierarchy` cuando hay que bajar por el organigrama (§5.5). Ahí sí sigue siendo
  cierto que alguien encabeza un área y es integrante de otra: eso vive en
  `area_members.is_area_leader`, que es donde `schema-proofing` lo puso.

La consecuencia a tener presente: un rol por área sería la única forma de expresar a alguien
que puede *editar* en un área y solo *leer* en otra. Hoy eso no se puede decir, y si algún
día hiciera falta, la forma es la que esta sección describía —`role_id` en `area_members`—
con el costo de tocar cada punto donde se autoriza. No es una omisión: es el caso que se
decidió no soportar.

### 5.3 `logs` registraba quién hizo qué, pero no sobre qué — cerrado

`RF-USR-07` pide bitácora sobre proyecto, estatus, archivo y factura. `logs(user_id, action_id, created_at)` no tenía referencia al objeto, así que "quién borró esta factura"
no tenía respuesta.

**Cómo se cerró.** `target_table` y `target_id`, más `before_data`/`after_data`. No hay FK
posible porque el objetivo es una tabla distinta en cada fila; lo que sí se exige es que las
dos mitades viajen juntas, con el mismo patrón `num_nonnulls(...) IN (0, 2)` de
`event_participants` y `access_tokens` — cero es legítimo (`user_login` no tiene objeto),
uno siempre es un error. Con esto §2.7 ya es implementable.

### 5.4 Los catálogos estaban vacíos — cerrado

El esquema era correcto y la base era inservible. Siete migraciones levantaron 26 tablas y
sembraron dos catálogos: `permissions` y la única fila de `absence_types` que necesitaba su
propio backfill. Todo lo demás a lo que apunta una llave foránea `NOT NULL` quedó vacío, y
eso no es un detalle cosmético: en una base recién migrada cierra los caminos de escritura.

- `users.role_id` y `users.contract_type_id` son `NOT NULL` y `roles` y `contract_types` no
  tenían filas: no se podía insertar un usuario, y sin usuario no hay sesión, ni autor, ni
  integrante de área, ni ausencia.
- `logs.action_id` es `NOT NULL` contra `actions`, vacía: `RF-USR-07` pide bitácora y no se
  podía escribir un solo renglón.
- `events.event_type_id` es `NOT NULL` contra `event_types`, vacía: la mitad de calendario
  quedaba igual de cerrada.
- `role_permissions` vacía. §5.2 dejó las asignaciones a coordinación por `RF-USR-05`, y ese
  criterio sigue siendo el correcto, pero suponía que alguien podía entrar a configurarlas.
  Nadie podía: el rol que configuraría tampoco tenía permisos.

**Cómo se cerró.** `catalog-bootstrap` siembra solo lo que un requerimiento nombra: los
cuatro roles de `RF-USR-02` más `finance` de `RF-USR-08`, los cuatro esquemas de
contratación de `RF-AUS-02`, las siete áreas de `RF-USR-01`, los cuatro `event_types`, el
tipo `dia_institucional` de `RF-AUS-09` y un catálogo de `actions`. Añade índices únicos en
`areas.name` y `contract_types.name` — no existían, así que dos "Imprenta" eran posibles,
por captura repetida o por el alta en caliente que exige `RF-USR-09` — y con ellos cada
`INSERT` es idempotente vía `ON CONFLICT`.

Dos asignaciones de permisos se siembran porque son definiciones, no configuración: `admin`
recibe todos, porque es el rol desde el que se configuran los demás y dejarlo vacío es el
bloqueo descrito arriba; `finance` recibe `finance.read` y nada más, porque esa asignación
*es* el rol según `RF-USR-08`. `worker` y `area_lead` quedan vacíos a propósito: ahí sí es
política de coordinación.

El catálogo de `actions` es genérico a propósito — `record_created`, `record_updated`,
`record_deleted`, `status_changed`, más un verbo con nombre donde el verbo dice algo que las
columnas no. `target_table` ya dice sobre qué tabla, y `before_data`/`after_data` ya dicen si
fue alta, cambio o baja, así que un juego de verbos por tabla los repetiría y crecería con
cada tabla nueva: la bitácora acabaría siendo una segunda copia peor del esquema.
`status_changed` es la excepción con nombre porque §2.7 pone ahí el historial de estatus, y
como código propio se consulta por índice en vez de comparando dos `jsonb`. No hay
`absence_approved`, pese al ejemplo en el comentario de `actions.code`: el estatus de un
permiso va a `absence_status_history` por `RF-AUS-13`, y mandarlo a `logs` obligaría a que
toda consulta sobre la bitácora recordara excluir `target_table = 'absences'` o lo filtraría.

**Lo que sigue pendiente:** `contract_type_entitlements` sigue vacía. Los topes por esquema
son las cifras del contrato colectivo y no están en ningún documento del repositorio.
Inventar un número plausible sería peor que dejarlo vacío: por `RF-AUS-04` cada fila afirma
qué tope estuvo vigente en un periodo, y una equivocada explicaría en silencio saldos ya
consumidos contra un tope que nunca existió. Es dato operativo que carga control de
personal, no una migración.

### 5.5 La organización era una lista, no una estructura — cerrado

`areas` era un catálogo plano: siete filas sin relación entre ellas. Dos requerimientos
necesitan que esa relación sea dato:

- `RF-USR-09` — dar de alta nuevas áreas **y coordinaciones** sin desarrollo, "dado que la
  estructura organizacional crece". Una coordinación no es otro tipo de registro: es un
  área con áreas debajo. Sin dónde decir cuál cuelga de cuál, dar de alta un área y dar de
  alta una coordinación son la misma operación y la diferencia vive solo en quien la
  recuerda.
- `RF-USR-04` — los responsables de área y la coordinación consultan el trabajo de "todos
  los usuarios a su cargo". Eso es un **subárbol** de áreas, no un área, y la consulta
  simplemente no se podía escribir.

**Cómo se cerró.** `area_hierarchy`, una fila por área que *tiene* padre. Sin fila = raíz,
así que la tabla guarda solo las excepciones: la mayoría de las áreas no cuelgan de nadie, y
una columna `parent_area_id` sobre `areas` habría sido siete NULL y el mismo join.

**La llave primaria es `child_area_id` sola**, y ahí está toda la decisión. La forma obvia
—y el primer borrador de la migración— era `PRIMARY KEY (parent_area_id, child_area_id)`,
que permite que un área tenga varios padres. Eso deja de ser un árbol, y el organigrama que
`RF-USR-09` implica se queda sin forma de dibujarse: el subárbol de un área con dos padres o
se dibuja dos veces —la misma gente en dos lugares, sin nada que indique que son un solo
equipo— o se dibuja una vez y la gráfica miente sobre una de las dos líneas de autoridad.
Con el hijo como llave, el segundo padre lo rechaza la base y no tiene que elegirlo el
frontend.

**Rechazado: una columna `level`** para colocar el nodo en el diagrama. La profundidad no es
un hecho del área, es consecuencia de dónde cuelga hoy, y mover un subárbol obligaría a
reescribir `level` en todos sus descendientes —una operación que nadie va a recordar hacer,
y que deja una gráfica que se dibuja con seguridad a la profundidad equivocada. Se calcula
con un CTE recursivo al leer. Contrasta con `file_locations`, donde la ubicación **sí** se
guarda: en qué disco están los bytes es una decisión que nada puede volver a derivar.

**Los ciclos de más de un salto no son restricción de tabla.** `CHECK (parent <> child)`
cubre el salto directo; A bajo B bajo A necesitaría un trigger o una cerradura transitiva
materializada, y ambos le cobran a cada escritura por algo que solo produce un UPDATE a
mano. En su lugar: `Areas.setParent()` rechaza como padre a un descendiente del hijo, y la
consulta de lectura lleva la cláusula `CYCLE` del CTE recursivo (Postgres 14+), de modo que
un ciclo escrito por `psql` trunca una rama en vez de colgar la petición. Es cinturón de
seguridad, no la guarda: quien agregue una segunda ruta de escritura a esa tabla debe la
misma verificación.

`ON DELETE CASCADE` de los dos lados: borrar un área elimina el enlace con su padre y los
enlaces con sus hijos, que quedan como raíces —siguen siendo dibujables. La alternativa,
`RESTRICT` del lado del padre, se niega a borrar una coordinación hasta que cada área abajo
se haya movido a mano, que es justamente el estado del que intenta salir quien reorganiza.

El rol sigue siendo global, y eso está decidido y no pendiente: `area_members` y
`area_hierarchy` contestan sobre qué registros ve cada quien, `role_permissions` contesta qué
puede hacer. Ver §5.2.

### 5.6 La bitácora existía pero nadie escribía en ella — cerrado

`logs` y `actions` estaban desde el esquema inicial, §5.3 les agregó el objeto
(`target_table`, `target_id`, `before_data`, `after_data`) y `catalog-bootstrap` sembró los
trece códigos de acción. No faltaba nada del modelo: faltaba que algo escribiera. `RF-USR-07`
—bitácora de quién creó, modificó o eliminó cada registro relevante— seguía sin cumplirse con
las cuatro tablas listas.

**Cómo se cerró.** Sin migración: es código. La orquestación anuncia lo que hizo por
`src/utils/events.js` y `access/orchestration/audit.js` lo convierte en una fila. Cuatro
decisiones que conviene no reabrir:

- **El actor no es un argumento.** Viaja en un `AsyncLocalStorage` que siembra
  `middlewares/context.js` por petición. Las alternativas eran pasar el usuario por unas
  treinta firmas de orquestación —una preocupación de bitácora en medio de los argumentos del
  dominio, que además crece cada vez que se quiera acarrear algo más— o emitir desde las
  rutas, que no conocen la fila anterior y tendrían que releerla. Fuera de una petición no hay
  contexto y el actor es nulo: un cambio hecho por `scripts/createAdmin.js` está genuinamente
  sin atribuir, y `logs.user_id` es nullable justamente para poder decirlo.
- **Es un despachador y no una llamada directa.** Ya se sabe quién se suscribe después:
  `RF-EST-03` y `RF-EST-06` necesitan avisar cuando un proyecto lleva demasiado en un estatus,
  y `RF-FLW-04` cuando un visto bueno habilita la siguiente etapa. Disparan sobre los mismos
  eventos.
- **Un suscriptor que falla no tumba la petición.** Se reporta con el evento completo a
  stderr y se sigue. El costo, dicho para que no se descubra: una escritura puede tener éxito
  y su fila de bitácora no, y nada las reconcilia. Es aceptable para usuarios, áreas y roles.
  **No** es evidentemente aceptable para FIN, cuyos registros necesitan integridad de
  auditoría; ahí la forma que no puede perder una fila es un CTE que escriba `logs` en la
  misma sentencia que el cambio, como `createUser()` ya escribe `area_members`.
- **La redacción es un patrón, no una lista.** `before_data` y `after_data` son filas enteras
  y una fila de `users` lleva `password_hash`. Se borra cualquier columna que empate
  `/password|secret|token|hash|salt/i`, de modo que una tabla nueva con un secreto queda
  redactada por omisión y hay que sacarla a mano de la regla, que es la dirección segura.

**Lo que se audita hoy** es lo que existe: `users`, `areas`, `area_members`, `roles`,
`permissions` y los otorgamientos de permiso, más el acceso (`user_login`,
`user_login_failed`). `status_changed` está sembrado y sin usar porque nada tiene estatus
todavía; entra con `RF-EST-01` en I3, y §2.7 es donde vive ese diseño. Los verbos de archivo
entran con ARC.

**El área de cada acción, y de dónde sale.** `logs.area_id` guarda el área a la que
pertenecía el actor cuando hizo el cambio (`1788899167759_log-area.sql`). Es lo que hace
contestable `RF-USR-04` —un responsable consulta el trabajo de todos a su cargo— sin nombrar
a cada persona una por una, y `RF-USR-03` toma el área como unidad, así que el área es lo que
la bitácora debe indexar.

Dos alternativas descartadas, porque las dos parecen más baratas y son peores:

- **Derivarla al leer**, cruzando `logs` con `area_members`. Contesta dónde está la persona
  **ahora**. Mover a alguien de Imprenta a Diseño convertiría retroactivamente en Diseño todo
  lo que hizo en su vida. La bitácora existe para decir qué era cierto **entonces**: por eso
  se desnormaliza, igual que `before_data` copia la fila en vez de apuntarla.
- **Tomarla del JWT.** Es gratis y está a la mano —el token ya podría cargarla— pero vive
  siete días y nada relee la base sobre un token verificado, así que quien cambie de área
  seguiría estampando la anterior durante el resto de la semana. Una bitácora
  confiadamente equivocada sobre el pasado es peor que una callada.

Lo que se hace en su lugar: `query.insertLog()` resuelve el área con una subconsulta **dentro
del mismo INSERT**. No cuesta un viaje extra —la fila se está insertando de todos modos— y
siempre lee el valor vigente. El token **sí** carga `areaId`, pero solo para que una pantalla
sepa de qué área es quien la abrió sin gastar una petición; es una foto, como `role`, y no es
lo que sella la bitácora.

Cuál área, dado que `area_members` es muchos a muchos: `users.primary_area_id`, la única
respuesta de un solo valor que tiene el esquema. Quien pertenece a dos áreas y actúa sobre la
segunda queda atribuido a la primera. Es una imprecisión conocida y es el límite honesto de
atribuir la acción al área de la *persona* en vez de a la del *registro afectado* —que es la
mejor pregunta y no tiene respuesta genérica, porque el registro afectado es una tabla
distinta en cada fila.

**Lo que sigue pendiente:** no hay ruta para *leer* la bitácora. `audit.forTarget()` y
`audit.forAreas()` están escritos y probados, pero sin endpoint ni pantalla, así que hoy la
bitácora se consulta por `psql`.

### 5.7 Una sesión no se podía revocar, solo esperar a que caducara — cerrado

Las cuentas se borran en suave: se marca `deleted_at` y `uq_users_email_live` libera la
dirección. Lo que eso no hacía era terminar la sesión que la persona ya tenía en la mano.
La sesión es un JWT sin estado y `verifyToken()` no releía `users`, así que una cuenta dada
de baja seguía sirviendo hasta siete días —`TOKEN_TTL`— y la única palanca era rotar
`JWT_SECRET`, que cierra la sesión de **todos**, no la de una.

Se toleraba mientras no hubiera forma de dar de baja por HTTP. Al abrir
`DELETE /api/users/:id` dejó de tolerarse: un endpoint que responde 200 y deja la cuenta
usable es peor que no tenerlo.

**Lo que se hace:** `users.token_version integer NOT NULL DEFAULT 0`. `issueToken()` lo
firma, `verifyToken()` lo compara contra la fila, y `query.deleteUser()` lo incrementa **en
la misma sentencia** que marca `deleted_at` —dos sentencias dejarían una ventana en la que
la cuenta ya no existe y su token todavía sirve, que es justo el hueco que la columna vino
a cerrar.

**Rechazado:** un `TOKEN_TTL` más corto acorta la ventana sin cerrarla, y la paga con un
login cada pocas horas para todo el mundo. Rechazada también una tabla de sesiones o una
lista de revocación: son un segundo almacén que mantener, y ninguno hace falta cuando la
fila del usuario ya se está leyendo.

**El costo, que es una reversión y conviene decirlo:** `verifyToken()` ahora hace una
lectura por llave primaria en cada petición autenticada, donde antes no leía nada y
`requireRole()` salía gratis. A decenas de usuarios y baja concurrencia es el precio
correcto, y compra algo más que la revocación: `role`, `roleId` y `areaId` salen de la fila
y no del token, así que un cambio de rol o de área surte efecto en la petición siguiente en
vez de esperar a que el token caduque. Los permisos siguen sin leerse ahí —
`requirePermission()` los consulta aparte, porque el catálogo es editable en tiempo de
ejecución (`RF-USR-05`).

### 5.8 La foto de perfil apuntaba a un almacén que nadie encendió — cerrado

`schema-proofing` §6 cambió `avatar_url text` por `avatar_file_id bigint REFERENCES
files (id)`, para que la foto fuera un objeto más del almacén direccionado por contenido.
Es el mejor modelo y no se revierte por sus méritos: `storage.js` está escrito pero **no
conectado** —nadie llama a `openVolumes()`— y conectarlo es I8. Mientras tanto,
`query.js` traía dos métodos, `updateProfilePicture` y `getUserProfilePicture`, que leían y
escribían una columna `profile_picture` que **nunca existió**: código muerto con forma de
función.

**Lo que se hace:** `profile_picture bytea` y `profile_picture_mime varchar(100)`, con un
`CHECK (num_nonnulls(...) IN (0, 2))` —el mismo patrón de `logs_target_complete`— porque
unos bytes sin tipo no le dicen al navegador si mira un PNG o un JPEG, y un tipo sin bytes
no es nada. Se elimina `avatar_file_id` en la misma migración: dos columnas para un mismo
hecho es exactamente la falla que `schema-proofing` existía para corregir, y nada la
escribía nunca, así que no se pierde dato alguno.

**Es deuda declarada, no una decisión de arquitectura.** Cuando I8 conecte el almacén, el
camino de vuelta es el Down de esta migración: reponer `avatar_file_id`, migrar los bytes a
`files` y soltar la columna. Ningún `RF-*` pide la foto de perfil; conviene saberlo antes de
defenderla.

## 6. Lo que falta de la columna vertebral, y cómo entra

`projects-spine` dejó FLW a medias y TSK sin empezar. No es un descuido: es el recorte que
permitió migrar algo usable sin comprometer el editor por nodos, que es la pieza más cara
de `RF-FLW-02`. Lo que sigue es el camino de vuelta, escrito ahora para que no se invente
después.

**FLW declarativo.** `workflows → workflow_versions → workflow_stages ⇄ workflow_transitions`,
con `position_x`/`position_y` en el nodo para que el diagrama sobreviva al guardado (§2.1),
`is_entry` para el enrutamiento (§2.5) y `requires_entity_approval` para el visto bueno de
doble parte (`RF-FLW-05`). Sobre lo ya migrado, tres cambios y ninguno más:

- `project_stages` gana `workflow_stage_id`, y el índice único pasa de
  `(project_id, area_id, seq, attempt)` a `(project_id, workflow_stage_id, attempt)` (§2.6).
- `schema_versions` gana `workflow_version_id`, y `requests.area_id` deja de escribirse a
  mano para derivarse de la etapa de entrada (§2.5).
- `projects` gana `workflow_version_id`, la versión con la que nació (§2.2).

**TSK.** `tasks`, `project_members`, `time_entries` y `notes`, todas colgando de `projects`
y opcionalmente de `project_stages`. Son tablas nuevas que agregan; ninguna altera lo que
ya está. `project_stages.assigned_to` —una persona por etapa— sigue siendo el primer reparto
del responsable de área (`RF-TSK-01`) y no se elimina cuando lleguen las tareas: son dos
granularidades distintas, no dos versiones de la misma.

**EST.** `alert_rules` y `notifications`, que son lo único que falta para `RF-EST-03`,
`RF-EST-04`, `RF-EST-06`, `RF-EST-09` y `RF-EST-10`; `status_since` ya está puesto y es la
mitad cara.

**Lo que no debe cambiar al hacer nada de lo anterior**, porque revertirlo cuesta el módulo
entero: `projects` no gana una etapa actual (§2.1), `requests` y `projects` siguen siendo
tablas distintas (§2.8) y una `schema_versions` publicada no se edita (§2.2).

## 7. Diccionario de datos

Las 38 tablas y la vista, tal como están en la base hoy. Es la referencia de "qué guarda
esta columna"; el porqué está en §2 y el estado de cada módulo en §1.

Convenciones de las tablas de abajo:

- **Tipo** es el tipo real de Postgres. `bigint` en una llave primaria siempre es
  `GENERATED ALWAYS AS IDENTITY`, así que no se repite en cada fila.
- **Nulo** dice si la columna admite `NULL`.
- **Predet.** es el `DEFAULT`; vacío significa que no tiene.
- Las llaves foráneas se anotan en la descripción como `→ tabla.columna`.
- Los `CHECK`, los índices parciales y las restricciones `EXCLUDE` **no** aparecen aquí:
  viven en el `.sql` de su migración, que es el único lugar donde se leen completos. El
  diccionario dice qué guarda cada columna, no todo lo que la restringe.

Esta sección se escribe a mano y se contrasta contra la base. Para verificarla después de
una migración, `dbml/current.dbml` es la instantánea generada y `npm run migrate:status`
dice si la base está al día.

### 7.1 USR — personas, áreas y autorización

#### `users`

Cuenta de una persona del equipo. Las crea un administrador; nadie se registra solo
(`RF-USR-01`, `RF-USR-02`).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `primary_area_id` | bigint | sí | | Área principal, la que se estampa en la bitácora → `areas.id` |
| `schedule_id` | bigint | sí | | Horario laboral como colección de eventos → `event_collections.id` |
| `contract_type_id` | bigint | no | | Esquema de contratación; decide los topes de ausencia → `contract_types.id` |
| `role_id` | bigint | no | | Rol global, no por área (§5.2) → `roles.id` |
| `email` | varchar(320) | no | | Identidad de acceso. Único **entre las cuentas vivas**: el índice es parcial sobre `deleted_at IS NULL` |
| `full_name` | varchar(200) | no | | Nombre para mostrar |
| `birthday` | date | sí | | Cumpleaños |
| `password_hash` | varchar(500) | sí | | bcrypt, costo 12. `NULL` significa **invitación sin canjear**: es lo que hace válido el token de alta, y llenarlo lo consume |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta de la cuenta |
| `deleted_at` | timestamptz | sí | | Baja lógica. Libera el correo para una cuenta nueva |
| `token_version` | int | no | `0` | Contador de revocación (§5.7). `verifyToken()` lo compara contra el claim en cada petición; subirlo invalida toda sesión anterior |
| `profile_picture` | bytea | sí | | Foto de perfil. Deuda declarada (§5.8): debería vivir en `files` cuando I8 encienda el almacén |
| `profile_picture_mime` | varchar(100) | sí | | Tipo MIME de la foto. Va con la anterior: ambas o ninguna |

#### `roles`

Catálogo de roles. Es global y se queda global; qué puede hacer cada uno lo dicen
`role_permissions` (`RF-USR-02`).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `name` | varchar(50) | no | | Único. `admin`, `area_lead`, `worker`, `finance` |
| `description` | text | sí | | Para qué es el rol |

#### `permissions`

Catálogo de permisos. Lectura y escritura son permisos **independientes**, que es lo que
`RF-USR-05` exige.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `code` | varchar(100) | no | | Único. `recurso.accion`, p. ej. `project.write` |
| `label` | varchar(200) | no | | Nombre visible |
| `description` | text | sí | | Qué habilita, con su `RF-*` |

#### `role_permissions`

Qué permisos tiene cada rol. Editable en caliente desde `PUT /api/roles/:id/permissions`,
por eso los permisos **no** viajan en el JWT.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `role_id` | bigint | no | | Parte de la llave primaria → `roles.id` |
| `permission_id` | bigint | no | | Parte de la llave primaria → `permissions.id` |

#### `areas`

Área o coordinación. Las dos son la misma tabla; lo que las distingue es su lugar en
`area_hierarchy` (`RF-USR-09`, §5.5).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `name` | varchar(200) | no | | Único |
| `description` | text | sí | | A qué se dedica |

#### `area_hierarchy`

El organigrama. `child_area_id` es la llave primaria **completa** —un solo padre por
área—, y eso es lo que hace que el árbol se pueda dibujar.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `child_area_id` | bigint | no | | Llave primaria; el área subordinada → `areas.id` |
| `parent_area_id` | bigint | no | | El área de la que cuelga → `areas.id` |

#### `area_members`

Quién pertenece a qué área. Es muchos a muchos: alguien puede estar en dos áreas y liderar
solo una (`RF-USR-03`).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `area_id` | bigint | no | | → `areas.id` |
| `user_id` | bigint | no | | → `users.id`. Único junto con `area_id` |
| `is_area_leader` | boolean | no | | Si lidera **esta** área. La jefatura vive aquí y en ningún otro lado (§5.5) |

#### `contract_types`

Esquemas de contratación: honorarios, eventual, base de confianza, base sindicalizada y
becario. Son condiciones de empleo (`RF-AUS-02`), así que agregar uno es una migración, no
un endpoint; lo configurable es `contract_type_entitlements`.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `name` | varchar(200) | no | | Único |

### 7.2 CAL / AUS — calendario, ausencias y saldos

#### `events`

Todo lo que ocupa tiempo: horarios, etapas de proyecto, ausencias y días festivos.
`starts_at`/`ends_at` describen la **primera** ocurrencia; las recurrencias se expanden al
leer, para la ventana pedida.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `event_type_id` | bigint | no | | → `event_types.id` |
| `title` | varchar(300) | no | | Título visible |
| `description` | text | sí | | Detalle libre |
| `all_day` | boolean | no | `false` | Evento de día completo |
| `starts_at` | timestamptz | no | | Inicio de la primera ocurrencia |
| `ends_at` | timestamptz | no | | Fin de la primera ocurrencia |
| `timezone` | text | no | `America/Mexico_City` | Zona con la que se expande la recurrencia |
| `rule` | text | sí | | Regla RFC 5545, p. ej. `FREQ=WEEKLY;BYDAY=MO,WE,FR`. `NULL` = ocurrencia única |
| `recurrence_until` | timestamptz | sí | | Fin de la recurrencia |
| `created_by` | bigint | sí | | Quién lo creó → `users.id` |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta del registro |

#### `event_types`

Catálogo del tipo de evento.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `code` | varchar(50) | no | | Único. `horario`, `proyecto`, `ausencia`, `festivo` |
| `label` | varchar(200) | no | | Nombre visible |

#### `event_participants`

A quién le aplica un evento. Exactamente uno de `user_id` / `area_id` va lleno; las filas
de área se abren a sus integrantes al consultar.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `event_id` | bigint | no | | → `events.id` |
| `area_id` | bigint | sí | | Participante colectivo → `areas.id` |
| `user_id` | bigint | sí | | Participante individual → `users.id` |

#### `event_exceptions`

Una ocurrencia concreta de un evento recurrente que se movió o se canceló, sin tocar la
serie.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `event_id` | bigint | no | | Serie a la que pertenece → `events.id` |
| `original_start` | timestamptz | no | | Qué ocurrencia sustituye. Único junto con `event_id` |
| `is_cancelled` | boolean | no | `false` | La ocurrencia no sucede |
| `starts_at` | timestamptz | sí | | Nuevo inicio, si se movió |
| `ends_at` | timestamptz | sí | | Nuevo fin, si se movió |

#### `event_collections`

Un conjunto de eventos con nombre: el horario de una persona, el calendario de un
proyecto, el periodo vacacional de un esquema.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `key` | varchar(200) | no | | Único. `horario_daniel`, `vacaciones_contrato_x` |
| `name` | varchar(300) | no | | Nombre visible |
| `description` | text | sí | | Para qué es |

#### `collection_events`

Qué eventos integran una colección.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `event_id` | bigint | no | | → `events.id` |
| `collection_id` | bigint | no | | → `event_collections.id`. Único junto con `event_id` |

#### `absences`

El permiso en sí. **Contiene lo restringido** por `RF-AUS-13` —el motivo y el respaldo
documental—, así que nada relacionado con disponibilidad lee esta tabla: para eso está la
vista `absence_availability`. La llave primaria es el evento, no un id propio: una ausencia
*es* un evento con detalle.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `event_id` | bigint | no | | Llave primaria → `events.id` |
| `reason` | text | no | | **Restringido** (`RF-AUS-13`): el motivo del permiso |
| `approved_by` | bigint | sí | | Quién autorizó → `users.id` |
| `approved_at` | timestamptz | sí | | Cuándo se autorizó |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Cuándo se solicitó |
| `document_file_id` | bigint | sí | | **Restringido**: respaldo documental → `files.id` |
| `absence_type_id` | bigint | no | | → `absence_types.id` |
| `status` | varchar(20) | no | `requested` | `requested`, `approved`, `rejected`, `cancelled`, `taken` (`RF-AUS-14`) |

#### `absence_types`

Catálogo de tipos de ausencia, configurable desde la aplicación (`RF-AUS-03`).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `code` | varchar(50) | no | | Único. `vacaciones`, `permiso_economico`, `incapacidad`, `dia_institucional` |
| `label` | varchar(200) | no | | Nombre visible |
| `unit` | varchar(10) | no | | Unidad de conteo: `day` u `hour` |
| `consumes_balance` | boolean | no | `true` | `false` para días institucionales, que aplican sin descontar saldo (`RF-AUS-09`) |
| `requires_document` | boolean | no | `false` | Si exige respaldo documental |
| `is_active` | boolean | no | `true` | Si se puede seguir solicitando |

#### `contract_type_entitlements`

El tope de días por (esquema × tipo × periodo de vigencia). Cambiar un tope **cierra** la
fila con `valid_to` e inserta otra; nunca se actualiza `amount`, para que lo ya consumido
siga explicándose con el tope vigente entonces (`RF-AUS-04`).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `contract_type_id` | bigint | no | | → `contract_types.id` |
| `absence_type_id` | bigint | no | | → `absence_types.id` |
| `amount` | numeric(6,2) | no | | Tope del periodo |
| `valid_from` | date | no | | Inicio de vigencia |
| `valid_to` | date | sí | | Fin de vigencia. `NULL` = sigue vigente |

Una restricción `EXCLUDE` (`cte_no_overlap`) impide que dos periodos del mismo esquema y
tipo se traslapen, porque entonces "el tope en la fecha D" sería ambiguo. No es expresable
en DBML: se lee en la migración.

#### `leave_balances`

Saldo por persona, tipo y ciclo. El ciclo es un par de fechas y no un año, porque el
sindicalizado no corre por año calendario.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `user_id` | bigint | no | | → `users.id` |
| `absence_type_id` | bigint | no | | → `absence_types.id` |
| `cycle_start` | date | no | | Inicio del ciclo. Único junto con `user_id` y `absence_type_id` |
| `cycle_end` | date | no | | Fin del ciclo |
| `granted` | numeric(6,2) | no | | Otorgado. Nace como copia del tope del esquema y se sube individualmente para las excepciones de `RF-AUS-05`, como los días por antigüedad |
| `used` | numeric(6,2) | no | `0` | Consumido. No puede exceder `granted` |
| `note` | text | sí | | Por qué se otorgó algo distinto al tope |

#### `absence_status_history`

Quién cambió el estatus de un permiso y cuándo. Es la excepción deliberada a §2.7: vive
aquí y no en `logs` por confidencialidad, para que lo restringido quede en una frontera
contigua.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `event_id` | bigint | no | | Permiso afectado → `absences.event_id`, en cascada |
| `status` | varchar(20) | no | | El estatus al que pasó |
| `changed_by` | bigint | sí | | Quién lo cambió → `users.id` |
| `changed_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Cuándo |
| `note` | text | sí | | Comentario del cambio |

#### `absence_availability` (vista)

Quién falta y cuándo, **sin** el motivo ni el respaldo. Es la costura que hace que
`RF-AUS-12` y `RF-AUS-13` puedan convivir: filtra los permisos a `approved` y `taken`, y
expone solo fechas, persona y área. Todo lo que calcule disponibilidad (`RF-TSK-06`,
`RF-TSK-07`, `RF-CAL-05`, `RF-CAL-06`) y la notificación de `RF-EST-10` leen esto y nunca
`absences`.

| Columna | Tipo | Descripción |
| --- | --- | --- |
| `event_id` | bigint | El evento de la ausencia |
| `starts_at` | timestamptz | Inicio de la primera ocurrencia |
| `ends_at` | timestamptz | Fin de la primera ocurrencia |
| `all_day` | boolean | Día completo |
| `timezone` | text | Zona del evento |
| `rule` | text | Recurrencia RFC 5545, si la hay |
| `recurrence_until` | timestamptz | Fin de la recurrencia |
| `user_id` | bigint | Quién falta |
| `area_id` | bigint | Área a la que aplica, si el participante es colectivo |

### 7.3 ARC — carpetas, archivos y almacenamiento

El almacén invierte lo habitual: **Postgres es el sistema de archivos y los discos son una
bolsa de bytes indexada por SHA-256**. La identidad es el contenido; el nombre, la ruta y el
dueño son columnas. No hay actualización de un archivo: otros bytes son otro hash.

#### `folders`

Carpeta. El árbol es propio del sistema, no de Drive (`RF-ARC-02`).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `parent_id` | bigint | sí | | Carpeta padre; `NULL` = raíz → `folders.id` |
| `name` | varchar(255) | no | | Nombre. Único entre hermanas vivas; en la raíz, único por dueño |
| `owner_id` | bigint | no | | Dueño → `users.id` |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |
| `deleted_at` | timestamptz | sí | | Baja lógica |

Un trigger (`folders_no_cycle`) rechaza que una carpeta sea su propia ancestra, cosa que
ninguna restricción declarativa puede atrapar.

#### `files`

Un archivo dentro de una carpeta. La fila es el nombre y el lugar; los bytes se ubican por
`hash`.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `folder_id` | bigint | no | | Carpeta contenedora → `folders.id` |
| `author_id` | bigint | no | | Quién lo subió → `users.id` |
| `hash` | char(64) | no | | SHA-256 del contenido, hex minúsculas. **No** es único: dos filas con el mismo hash es justo lo que significa deduplicar |
| `name` | varchar(255) | no | | Nombre visible. Único dentro de la carpeta |
| `size` | bigint | no | | Tamaño en bytes |
| `mime` | varchar(255) | sí | | Tipo MIME |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |
| `deleted_at` | timestamptz | sí | | Baja lógica |

#### `file_locations`

En qué disco están unos bytes. La colocación se **registra**, no se deriva: `hash % n`
rebarajaría todo el acervo al agregar un disco.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `hash` | char(64) | no | | Parte de la llave primaria; el contenido |
| `storage_volume_id` | bigint | no | | Parte de la llave primaria → `storage_volumes.id` |
| `verified_at` | timestamptz | sí | | Última verificación de que los bytes siguen ahí |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Cuándo se escribieron |

#### `storage_volumes`

Un disco montado. La base guarda **la etiqueta**, no la ruta: el mismo disco se monta en
rutas distintas en el host y en el contenedor.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `label` | varchar(100) | no | | Único. La mitad izquierda de `STORAGE_VOLUMES` (`etiqueta:ruta`) |
| `location` | varchar(500) | sí | | Ruta de referencia; informativa |
| `is_writable` | boolean | no | `true` | Si admite escrituras nuevas |
| `max_storage` | bigint | sí | | Tope en bytes; `NULL` = sin tope |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |

#### `folder_areas`

Qué área ve qué carpeta y con qué nivel. Es lo que da `RF-USR-03` sobre archivos.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `folder_id` | bigint | no | | Parte de la llave primaria → `folders.id` |
| `area_id` | bigint | no | | Parte de la llave primaria → `areas.id` |
| `level` | varchar(10) | no | | Nivel de acceso concedido |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |

#### `access_tokens`

Enlace de compartición. Es lo que cumple `RF-ARC-03` y `RF-EXT-03`: el externo ve y nunca
edita, sustituye ni borra. Apunta a una carpeta **o** a un archivo, no a ambos.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `token_hash` | char(64) | no | | Único. Hash del token; el token en claro solo lo tiene quien recibió el enlace |
| `folder_id` | bigint | sí | | Carpeta compartida → `folders.id` |
| `file_id` | bigint | sí | | Archivo compartido → `files.id` |
| `level` | varchar(10) | no | | Nivel concedido |
| `authorizer` | bigint | no | | Quién emitió el enlace → `users.id` |
| `expires_at` | timestamptz | no | | Caducidad |
| `revoked_at` | timestamptz | sí | | Revocación anticipada |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Emisión |

### 7.4 Bitácora

#### `logs`

Quién hizo qué, sobre qué y desde qué área (`RF-USR-07`). La escribe únicamente
`access/orchestration/audit.js`, suscrito a los eventos que emite la orquestación; el actor
no es un argumento, sale del `AsyncLocalStorage` de la petición.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `user_id` | bigint | sí | | Quién actuó → `users.id`. `NULL` fuera de una petición (un script) o cuando el correo no corresponde a ninguna cuenta |
| `action_id` | bigint | no | | Qué hizo → `actions.id` |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Cuándo |
| `target_table` | varchar(50) | sí | | Tabla afectada. **No** es llave foránea: el objetivo es otra tabla en cada fila |
| `target_id` | bigint | sí | | Llave primaria de la fila afectada, dentro de `target_table` |
| `before_data` | jsonb | sí | | La fila antes. `NULL` = se creó. Las columnas que casan con `/password\|secret\|token\|hash\|salt/i` se borran antes de guardar |
| `after_data` | jsonb | sí | | La fila después. `NULL` = se eliminó |
| `area_id` | bigint | sí | | Área del actor **en ese momento**, tomada de `users.primary_area_id` dentro del propio INSERT → `areas.id`. `NULL` = no registrada, nunca "sin área" |

#### `actions`

Catálogo cerrado de acciones. Emitir un código que no está aquí lanza excepción en vez de
saltarse la fila: un hueco silencioso en una bitácora es peor que uno ruidoso.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `code` | varchar(50) | no | | Único. `record_created`, `status_changed`, `user_login`… Los cuatro `record_*` son agnósticos de la tabla, y por eso las tablas nuevas no necesitan códigos nuevos |
| `label` | varchar(200) | no | | Nombre visible |

### 7.5 SOL / PRY / FLW / EST — solicitudes, proyectos, etapas y estatus

#### `entities`

La entidad solicitante: una facultad, una dependencia, una coordinación o alguien externo
(`RF-SOL-07`). Persiste entre solicitudes; sus contactos cambian y viven aparte.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `name` | varchar(300) | no | | Único entre las vivas |
| `kind` | varchar(20) | sí | | `facultad`, `dependencia`, `coordinacion`, `externo` |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |
| `deleted_at` | timestamptz | sí | | Baja lógica |

#### `entity_contacts`

La persona con la que se trata. Es también la identidad del externo para `RF-EXT-01` y
quien firma el lado externo del visto bueno de `RF-FLW-05`.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `entity_id` | bigint | no | | → `entities.id` |
| `full_name` | varchar(200) | no | | Nombre |
| `email` | varchar(320) | sí | | Correo. Único por entidad, comparado en minúsculas, para que la misma persona no acabe en dos filas |
| `phone` | varchar(50) | sí | | Teléfono |
| `job_title` | varchar(200) | sí | | Puesto o cargo |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |
| `deleted_at` | timestamptz | sí | | Baja lógica |

#### `schemas`

Identidad estable de un formato de solicitud (`RF-SOL-01`). Su contenido vive en
`schema_versions`; esta fila solo lo nombra.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `code` | varchar(50) | no | | Único. `formato_02`, `papel_institucional` |
| `name` | varchar(300) | no | | Nombre visible |
| `is_active` | boolean | no | `true` | Si se puede seguir usando para capturar |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |

#### `schema_versions`

Cómo se veía el formato cuando se capturó algo con él. **Inmutable una vez publicada**
(§2.2): editar publica una versión nueva, y un trigger rechaza todo `UPDATE` sobre la tabla.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `schema_id` | bigint | no | | → `schemas.id` |
| `version` | int | no | | Consecutivo desde 1. Único junto con `schema_id` |
| `fields` | jsonb | no | `[]` | Arreglo **ordenado** de definiciones de campo: `key`, `label`, `type`, `required`, `options`. El orden de captura es el orden del arreglo |
| `published_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Publicación |
| `published_by` | bigint | sí | | Quién publicó → `users.id` |

#### `sheets`

El libro de Excel que sigue vivo durante la transición, y cómo sus columnas caen en un
formato (`RF-MIG-01`, `RF-MIG-02`).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `name` | varchar(300) | no | | Cómo se le dice al libro |
| `drive_id` | varchar(255) | no | | Drive de Graph. Junto con `item_id` y `table_name` identifica el libro; único entre los vivos |
| `item_id` | varchar(255) | no | | Elemento de Graph |
| `table_name` | varchar(200) | sí | | Tabla dentro del libro. `NULL` = la primera o única |
| `web_url` | text | sí | | Enlace que un humano pega. Decorativo: la llave es el par drive/item |
| `schema_version_id` | bigint | no | | Formato destino → `schema_versions.id`. Apunta a la **versión**, no al formato, porque el mapeo se escribe contra columnas concretas |
| `column_map` | jsonb | no | `{}` | Encabezado del Excel → campo de `schema_versions.fields` o columna promovida de `requests` |
| `last_imported_at` | timestamptz | sí | | Hasta dónde llegó la última importación, para que la siguiente sepa desde dónde seguir |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |
| `deleted_at` | timestamptz | sí | | Baja lógica |

#### `statuses`

Catálogo de estatus, con dimensión de área (`RF-EST-02`). `area_id` nulo es el catálogo
global, que es el punto de partida de todas las áreas y viene sembrado con los siete que
nombra `RF-EST-01`.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `area_id` | bigint | sí | | Área dueña del estatus → `areas.id`. `NULL` = global |
| `code` | varchar(50) | no | | `recibido`, `en_proceso`, `esperando_vb`… Único dentro del área, y único entre los globales |
| `label` | varchar(200) | no | | Nombre visible |
| `sort_order` | int | no | `0` | Orden de presentación |
| `is_terminal` | boolean | no | `false` | Si el registro se considera cerrado. `RF-EST-05` valida el cierre contra esto |
| `is_active` | boolean | no | `true` | Si se puede seguir asignando |

#### `requests`

La solicitud. Existe desde que entra, tenga o no proyecto (§2.8): `project_id` nulo es
exactamente lo que consulta la bandeja del área.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `folio` | varchar(50) | no | secuencia | Único y consultable (`RF-SOL-03`). Lo genera `requests_folio_seq` con formato `SOL-000001`, no la orquestación |
| `schema_version_id` | bigint | no | | Formato con el que se capturó → `schema_versions.id` |
| `project_id` | bigint | sí | | Proyecto al que se convirtió → `projects.id`. `NULL` = sin convertir. Varias solicitudes pueden apuntar al mismo (`RF-PRY-01`) |
| `entity_id` | bigint | sí | | Quién solicita → `entities.id` |
| `contact_id` | bigint | sí | | Con quién se trata → `entity_contacts.id` |
| `area_id` | bigint | sí | | Bandeja en la que cayó → `areas.id`. Puente hasta que el flujo enrute (§2.5) |
| `title` | varchar(300) | no | | Nombre corto de lo solicitado |
| `data` | jsonb | no | `{}` | **La captura completa** (`RF-SOL-06`), con la forma que dicte `schema_versions.fields`. Lo que `RF-SOL-05` busca sube a columnas reales en vez de quedarse aquí |
| `status_id` | bigint | no | | → `statuses.id` |
| `status_since` | timestamptz | no | `CURRENT_TIMESTAMP` | Desde cuándo lleva ese estatus. Lo mueve quien mueve `status_id` |
| `assignee_id` | bigint | sí | | Responsable → `users.id` |
| `priority` | int | no | `0` | Prioridad manual. Mayor es más urgente; no hay FIFO (`RF-FLW-08`) |
| `source` | varchar(20) | no | `form` | `form`, `email`, `sheet`, `manual`. Las que llegan por correo se registran a mano en el mismo formato (`RF-SOL-08`) |
| `sheet_id` | bigint | sí | | Libro del que se importó → `sheets.id`. Solo puede ir lleno si `source = 'sheet'` |
| `folder_id` | bigint | sí | | Carpeta con lo que adjuntó el solicitante → `folders.id` |
| `created_by` | bigint | sí | | Quién la capturó → `users.id` |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Entrada |
| `deleted_at` | timestamptz | sí | | Baja lógica |

#### `projects`

El proyecto (`RF-PRY-02`). Las áreas participantes **se derivan** de sus etapas y no se
guardan, y no hay etapa actual: eso es el conjunto de `project_stages` activas (§2.1).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `key` | varchar(50) | no | | Identificador corto y legible; sirve como nombre de carpeta. Se asigna, no se genera. Único entre los vivos, y restringido a mayúsculas, dígitos, `-` y `_` |
| `title` | varchar(300) | no | | Nombre del proyecto |
| `description` | text | sí | | Detalle |
| `entity_id` | bigint | sí | | Quién lo pidió → `entities.id` |
| `contact_id` | bigint | sí | | Con quién se trata → `entity_contacts.id` |
| `schema_version_id` | bigint | sí | | Formato del que nació → `schema_versions.id` |
| `status_id` | bigint | no | | Estatus visible → `statuses.id` (`RF-EST-01`) |
| `status_since` | timestamptz | no | `CURRENT_TIMESTAMP` | Desde cuándo. Desnormalizado para que la alerta de `RF-EST-03`/`RF-EST-04` no recorra la bitácora |
| `priority` | int | no | `0` | Prioridad manual por urgencia (`RF-FLW-08`) |
| `has_cost` | boolean | no | `false` | Con costo o sin costo; el tratamiento financiero difiere (`RF-PRY-07`) |
| `carried_over` | boolean | no | `false` | Rezagado de un periodo anterior (`RF-PRY-08`). El `period_id` espera a que exista `periods` |
| `starts_on` | date | sí | | Inicio previsto |
| `due_on` | date | sí | | Compromiso de entrega. No puede ser anterior a `starts_on` |
| `folder_id` | bigint | sí | | Carpeta del proyecto → `folders.id` (`RF-ARC-01`) |
| `event_collection_id` | bigint | sí | | Para que aparezca en el calendario como una colección → `event_collections.id` |
| `created_by` | bigint | sí | | Quién lo creó → `users.id` |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |
| `closed_at` | timestamptz | sí | | Cierre |
| `archived_at` | timestamptz | sí | | Archivado: sale del tablero. Distinto de eliminar |
| `deleted_at` | timestamptz | sí | | Baja lógica |

#### `project_stages`

Cada paso por el que pasa el proyecto (`RF-FLW-01`, `RF-PRY-03`). Varias pueden estar
activas a la vez, que es `RF-FLW-09`.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `project_id` | bigint | no | | → `projects.id` |
| `area_id` | bigint | no | | Área que la atiende → `areas.id` |
| `title` | varchar(300) | no | | Qué se hace en esta etapa |
| `seq` | int | no | `1` | Orden de presentación dentro del proyecto. **No decide qué sigue** |
| `attempt` | int | no | `1` | Reintento. Un visto bueno rechazado devuelve el trabajo y la etapa se repite (§2.6). Único junto con `project_id`, `area_id` y `seq` |
| `status` | varchar(20) | no | `pending` | `pending`, `active`, `waiting_external`, `done`, `cancelled`. Es la máquina del flujo, distinta del estatus visible del proyecto |
| `blocked_reason` | text | sí | | Motivo del bloqueo. **Obligatorio** cuando `status = 'waiting_external'` (`RF-FLW-07`) |
| `assigned_to` | bigint | sí | | A quién se le asignó → `users.id`. Es el primer reparto del responsable de área (`RF-TSK-01`), no el desglose en tareas |
| `event_id` | bigint | sí | | Para que aparezca en el calendario como tiempo de desarrollo previsto → `events.id` |
| `started_at` | timestamptz | sí | | Inicio real |
| `ended_at` | timestamptz | sí | | Fin real. No puede ser anterior a `started_at` |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |

#### `approvals`

El visto bueno (`RF-FLW-03`). Es objeto de negocio y no traza, porque `RF-EST-05` pregunta
por **los que faltan** y una bitácora no se puede consultar por ausencia. El visto bueno de
doble parte de `RF-FLW-05` son dos filas, una por lado.

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `project_stage_id` | bigint | no | | Etapa que se aprueba → `project_stages.id`, en cascada |
| `decision` | varchar(20) | no | | `approved` o `rejected` |
| `approver_user_id` | bigint | sí | | Firmante interno → `users.id` |
| `approver_contact_id` | bigint | sí | | Firmante externo → `entity_contacts.id`. Exactamente uno de los dos va lleno |
| `comment` | text | sí | | Comentario opcional de la decisión |
| `decided_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Cuándo se firmó |

#### `project_field_values`

Los datos que una etapa produce y otra consume sin recaptura (`RF-FLW-06`, `RF-IMP-08`): el
número de orden que genera diseño y que imprenta ocupa para facturar. También es donde se
capturan a mano los folios que generan el SIN y el sistema financiero (`RF-MIG-04`).

| Columna | Tipo | Nulo | Predet. | Descripción |
| --- | --- | --- | --- | --- |
| `id` | bigint | no | identidad | Llave primaria |
| `project_id` | bigint | no | | → `projects.id`, en cascada |
| `key` | varchar(100) | no | | Nombre del dato: `numero_orden`, `folio_sin`, `pantone`. Único por proyecto |
| `value` | text | no | | El valor. Indexado junto con `key` porque la búsqueda es por igualdad |
| `produced_by_stage_id` | bigint | sí | | Qué etapa lo generó → `project_stages.id`. Es lo que un JSONB acumulado no puede decir |
| `created_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Alta |
| `updated_at` | timestamptz | no | `CURRENT_TIMESTAMP` | Última corrección |
