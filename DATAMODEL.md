# Datamodel

Aquí estarán los diccionarios de datos y la descripción de las dinámicas por las que se
consume la api.

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
| **SOL, PRY, FLW, TSK, EST** | —                                                                                                                                                                                                                                       | **Propuesto**: la forma en `design/`, el porqué en §2, la cobertura en §3 |
| FIN, INV, IMP, RPT, EXT           | —                                                                                                                                                                                                                                       | Sin modelar; §4 describe los puntos de enganche                                     |

Los archivos de diseño se escriben a mano y no los toca `scripts/genDBML.js`: viven fuera
de `dbml/`, que es salida generada. Todos importan en ChartDB con **Import DBML**.

Ojo: están en `docs/design/` del directorio contenedor `ImagenUAQ/`, **fuera de este
repositorio**, junto a los requerimientos. Quien clone solo `imagenuaq-backend` no los
tiene y los enlaces de abajo le quedan muertos.

| Archivo                                                         | Alcance                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [`../docs/design/projects.dbml`](../docs/design/projects.dbml) | **MVP.** Proyectos y solicitudes, más los catálogos de los que dependen           |
| [`../docs/design/tasks.dbml`](../docs/design/tasks.dbml)       | **MVP.** Tareas, para conectar a mano con el anterior                               |
| [`../docs/design/spine.dbml`](../docs/design/spine.dbml)       | La columna vertebral completa, incluidos formatos y flujo. Referencia de a dónde va esto |

El MVP recorta del `spine` dos cosas, y las secciones que las describen siguen siendo la
referencia de cómo vuelven a entrar:

- **Formatos** (`forms`, `form_versions`, `form_fields`, §2.2 y §2.3). `requests` queda
  mínima: guarda la captura en `data jsonb` y el origen en `form_code` como texto suelto.
  Eso ya cubre `RF-MIG-01` — las respuestas quedan en la base mientras el Excel sigue
  vivo — sin comprometer todavía el modelo de formatos.
- **Flujo** (`workflows`, `workflow_stages`, `project_stages`, `approvals`, §2.1 y §2.6).
  El proyecto avanza por `status_id`. Las columnas que apuntan a una etapa
  (`notes.project_stage_id`, `tasks.project_stage_id`, `project_field_values`) no existen
  aún; entran con el módulo.

## 1. La columna vertebral

Cinco módulos que se leen como una sola cadena, y de los que cuelgan todos los demás:

```
entities ─┬─ requests ──→ projects ─┬─ project_stages ──→ approvals
          │   (form_versions,        ├─ tasks
          │    data JSONB)           ├─ notes / time_entries
          └─ entity_contacts         └─ project_field_values

workflows → workflow_versions → workflow_stages ⇄ workflow_transitions   (grafo)
```

Una solicitud entra por un formato (`form_versions`), recibe folio y cae en la bandeja del
área (`RF-SOL-03`, `RF-SOL-04`). Una o varias solicitudes se convierten en proyecto
(`RF-PRY-01`). El proyecto instancia la versión de un flujo: cada nodo por el que pasa es
una fila en `project_stages`, y cada visto bueno una fila en `approvals` (`RF-FLW-03`,
`RF-PRY-03`). Las tareas cuelgan del proyecto y, opcionalmente, de la etapa.

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

### 2.2 Formatos y flujos se versionan; las versiones publicadas son inmutables

`RF-SOL-01` y `RF-FLW-02` piden que coordinación dé de alta formatos y flujos sin
desarrollo. Si esas definiciones se editan en su lugar, dos cosas se rompen: una solicitud
vieja deja de poder mostrarse con los campos con los que se capturó, y un proyecto en
vuelo cambia de flujo a media ejecución.

Por eso `forms → form_versions → form_fields` y `workflows → workflow_versions → workflow_stages`. Editar publica una versión nueva; `requests.form_version_id` y
`projects.workflow_version_id` apuntan a la versión con la que nacieron y nunca se mueven.

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
- `form_fields` sí son filas, no JSON: el constructor de formatos y el validador los
  consultan y los ordenan.

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

En vez de una tabla `form_target_areas` en paralelo, `form_versions.workflow_version_id`
apunta al flujo, y las etapas marcadas `is_entry` definen a qué áreas cae. Un solo lugar
decide el enrutamiento, que es también lo que `RF-FLW-04` automatiza al dar el visto bueno.
Es la misma lección de la migración `schema-proofing`: la jefatura de área estaba en tres
lugares y ninguno los mantenía de acuerdo.

**Revisable.** Si aparece un formato que debe existir sin flujo, la salida es permitir
`workflow_version_id` nulo más un área de destino explícita, no reintroducir la tabla
paralela.

### 2.6 Las etapas se pueden repetir

Un visto bueno rechazado devuelve el trabajo a diseño. Por eso `project_stages` no es
única por `(project_id, workflow_stage_id)` sino por `(project_id, workflow_stage_id, attempt)`. Sin el contador, el reproceso o sobrescribe la historia o falla al insertar —
y `RF-PRY-03` pide justamente esa historia.

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
llega a divergir.

## 3. Trazabilidad

| RF                              | Cubierto por                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| RF-SOL-01                       | `forms`, `form_versions`, `form_fields`                                                                       |
| RF-SOL-02                       | `form_versions.workflow_version_id` → `workflow_stages.is_entry` (§2.5)                                       |
| RF-SOL-03                       | `requests.folio` (único)                                                                                         |
| RF-SOL-04, RF-SOL-05            | Columnas promovidas de`requests` (§2.3)                                                                          |
| RF-SOL-06                       | `requests.data`, `requests.folder_id`                                                                           |
| RF-SOL-07                       | `entities`, `entity_contacts`                                                                                   |
| RF-SOL-08                       | `requests.source`                                                                                                 |
| RF-PRY-01                       | `requests.project_id`                                                                                             |
| RF-PRY-02                       | `projects`, `project_members`; las áreas participantes se derivan, no se guardan                               |
| RF-PRY-03                       | `project_stages` + `approvals` + `logs`                                                                       |
| RF-PRY-04                       | `time_entries`                                                                                                    |
| RF-PRY-05                       | `notes.kind`                                                                                                      |
| RF-PRY-06                       | `workflows` reutilizables; sin estructura nueva por eventualidad                                                  |
| RF-PRY-07                       | `projects.has_cost`                                                                                               |
| RF-PRY-08                       | `projects.period_id`, `carried_over`                                                                            |
| RF-PRY-09                       | `project_materials.origin`                                                                                        |
| RF-FLW-01, RF-FLW-02            | `workflow_stages` + `workflow_transitions` (§2.1)                                                              |
| RF-FLW-03                       | `approvals`                                                                                                       |
| RF-FLW-04                       | `workflow_transitions` + `notifications`                                                                        |
| RF-FLW-05                       | `approvals.approver_contact_id`, `requires_entity_approval`                                                     |
| RF-FLW-06                       | `project_field_values` (§2.4)                                                                                    |
| RF-FLW-07                       | `project_stages.status = 'waiting_external'`, `blocked_reason`                                                  |
| RF-FLW-08                       | `priority`; sin orden por fecha de llegada                                                                        |
| RF-FLW-09                       | Grafo con ramas paralelas (§2.1)                                                                                   |
| RF-TSK-01 … RF-TSK-05          | `tasks`                                                                                                           |
| RF-TSK-06, RF-TSK-07            | Consulta sobre`events` + `area_members`; sin tabla nueva                                                        |
| RF-EST-01                       | `projects.status_id`                                                                                              |
| RF-EST-02                       | `statuses.area_id`                                                                                                |
| RF-EST-03, RF-EST-04, RF-EST-09 | `alert_rules` + `status_since`                                                                                  |
| RF-EST-05                       | Sin tabla: regla de orquestación sobre`expected_invoice_count`, las etapas sin `approvals` y la evidencia      |
| RF-EST-06, RF-EST-10            | `notifications`                                                                                                   |
| RF-EST-07, RF-EST-08            | Consulta sobre`projects` + `status_since`                                                                       |
| RF-CAL-03                       | `period_closures` + `projects.has_cost`                                                                         |
| RF-USR-01, RF-USR-02            | `users`, `areas`, `area_members`, `roles`                                                                   |
| RF-USR-03, RF-USR-04            | `area_members` + `area_hierarchy` (§5.5): el área propia y, recorriendo el árbol, todo lo que cuelga de ella |
| RF-USR-05, RF-USR-10            | `permissions` + `role_permissions` (§5.2)                                                                      |
| RF-USR-07                       | `logs` con `target_table`/`target_id` (§5.3)                                                                 |
| RF-USR-09                       | `areas` + `area_hierarchy` (§5.5): un área y una coordinación son la misma tabla                             |

`RF-TSK-07` y `RF-CAL-06` cruzan con ausencias: la ocupación del área debe descontar las
ausencias autorizadas. Se resuelven leyendo `events` (público) y **nunca** `absences`
(restringido) — la misma frontera que obliga a que la notificación de `RF-EST-10` lleve
fechas y duración pero nunca el motivo.

## 4. Puntos de enganche de los módulos restantes

Lo que la columna vertebral deja preparado, para no rediseñarla al llegar a ellos:

- **FIN** — `projects.expected_invoice_count`, `entities` como destinatario del cobro,
  `project_field_values` para el número de orden que `RF-IMP-08` pasa a facturación
  imprenta. Faltan `providers`, `quotes`, `invoices`, `oficios`, `payments`.
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
