-- Up Migration

-- The schema was correct and the database was unusable.
--
-- Seven migrations built 26 tables and seeded exactly two catalogues: `permissions`
-- (role-permissions) and the one `absence_types` row its own backfill needed. Everything
-- else that a NOT NULL foreign key points at was left empty, which is not a cosmetic
-- omission - on a fresh `migrate:up` it makes the core write paths unreachable:
--
--   users.role_id and users.contract_type_id are NOT NULL, and `roles` and
--   `contract_types` have no rows. No user can be inserted, so no session, no author, no
--   area member and no absence can exist either.
--
--   logs.action_id is NOT NULL and references `actions`, which has no rows. RF-USR-07
--   asks for a trail over every relevant record; today not one line can be written.
--
--   events.event_type_id is NOT NULL and `event_types` has no rows, so the calendar half
--   (CAL/AUS) is equally closed.
--
--   `role_permissions` is empty, and the migration that created it left the grants to
--   coordination on purpose (RF-USR-05). That reasoning holds, but it assumed somebody
--   could sign in and configure them. Nobody can: the role that would do the configuring
--   holds no permissions either.
--
-- Rejected: seeding from the application at boot. It is the usual answer and it is wrong
-- here for the same reason the permission catalogue was seeded in SQL - these rows are
-- referenced by NOT NULL constraints, so their absence is a schema-level failure rather
-- than a start-up detail, and a boot-time seed runs against every environment on every
-- restart with no record of what it changed. Rejected too: a separate `seeds/` directory,
-- which would be a second mechanism that `migrate:status` cannot report on.
--
-- What is seeded here is only what a requirement names. Values that come from outside the
-- documents - the caps of each contract scheme, which are the collective contract's
-- figures - are deliberately NOT invented; see section 3.
--
-- Closes DATAMODEL.md 5.4.


-- 1. Uniqueness on the two catalogues addressed by name
--
-- `areas.name` and `contract_types.name` carry no constraint, so this seed could be
-- applied twice and leave two "Imprenta" rows that a human reads as one. RF-USR-09 has
-- coordination adding areas at runtime, which is the same hazard by hand. The index is
-- also what makes every INSERT below idempotent through ON CONFLICT, so re-running this
-- migration after a partial failure is safe.
--
-- Plain UNIQUE indexes, not partial ones like uq_users_email_live: neither table has a
-- deleted_at, because a catalogue row that has been referenced cannot be deleted at all.

CREATE UNIQUE INDEX uq_areas_name          ON areas (name);
CREATE UNIQUE INDEX uq_contract_types_name ON contract_types (name);


-- 2. Roles - RF-USR-02
--
-- The requirement asks for at least three levels: integrante de area, responsable de area
-- and coordinacion/secretaria particular. The names below are the ones the roles.name
-- comment has claimed since the initial schema; this migration turns that comment into
-- rows rather than choosing anything new.
--
-- `finance` is the fourth, and it is not a rung on that ladder: RF-USR-08 asks for a
-- transversal read-only view of invoices and quotes from any area, which is a different
-- axis from seniority and the reason permissions are rows rather than an ordered level
-- column (see the role-permissions migration).

INSERT INTO roles (name) VALUES
    ('worker'),     -- integrante de area
    ('area_lead'),  -- responsable de area
    ('admin'),      -- coordinacion / secretaria particular
    ('finance')     -- RF-USR-08, lectura financiera transversal
ON CONFLICT (name) DO NOTHING;


-- 3. Contract schemes - RF-AUS-02
--
-- The four schemes are enumerated verbatim in RF-AUS-02 and determine which absence types
-- and caps apply to a person.
--
-- Their caps are NOT seeded. contract_type_entitlements is the table that would hold them,
-- and its rows are the collective contract's figures, which appear in no document here.
-- Inserting a plausible number would be worse than inserting nothing: RF-AUS-04 makes
-- every entitlement row an assertion about what was in force during a validity period, and
-- a wrong one silently explains consumed history against a cap that never existed. An
-- empty table makes the omission visible; a guessed 20 does not.

INSERT INTO contract_types (name) VALUES
    ('Honorarios'),
    ('Eventual'),
    ('Base de confianza'),
    ('Base sindicalizada')
ON CONFLICT (name) DO NOTHING;


-- 4. Areas - RF-USR-01
--
-- The seven the requirement lists. "Coordinacion" is not a container above these: the
-- interviews use it interchangeably with secretaria particular, so it is one of the seven
-- rows and not a parent_id. Nothing here freezes the list - RF-USR-09 requires adding
-- areas without a deploy, and the `area.manage` permission is what will allow it.

INSERT INTO areas (name) VALUES
    ('Secretaría Particular'),
    ('Producción Audiovisual'),
    ('Diseño Gráfico'),
    ('Diseño Web'),
    ('Administración'),
    ('Imprenta'),
    ('Impresión')
ON CONFLICT (name) DO NOTHING;


-- 5. Event types
--
-- The four the event_types.code comment has named since the initial schema. `events` is
-- the single calendar table behind schedules, project dates, absences and institutional
-- non-working days, and event_type_id is what tells them apart - RF-AUS-08 and RF-AUS-09
-- both read as "a festivo applies to everyone and consumes nothing", which is only
-- expressible once `festivo` exists as a row.

INSERT INTO event_types (code, label) VALUES
    ('horario',  'Horario laboral'),
    ('proyecto', 'Fecha de proyecto'),
    ('ausencia', 'Ausencia o permiso'),
    ('festivo',  'Día institucional no laborable')
ON CONFLICT (code) DO NOTHING;


-- 6. Absence types beyond vacaciones - RF-AUS-03, RF-AUS-09
--
-- Only one row is added, and the restraint is the point. RF-AUS-03 puts this catalogue in
-- the application's hands with no development, so seeding a full list of leave types would
-- be inventing policy that coordination is meant to enter. `dia_institucional` is the
-- exception because RF-AUS-09 names it explicitly and it is the only absence type the
-- requirements describe by its behaviour rather than by its name: it applies to staff
-- without drawing anybody's balance down, which is exactly consumes_balance = false - the
-- column that exists for it and, until now, had no row demonstrating it.

INSERT INTO absence_types (code, label, unit, consumes_balance, requires_document) VALUES
    ('dia_institucional', 'Día institucional no laborable', 'day', false, false)
ON CONFLICT (code) DO NOTHING;


-- 7. Actions - RF-USR-07
--
-- The catalogue is deliberately small and generic. logs.target_table already says what
-- kind of row was touched and before_data/after_data already say whether it was an insert,
-- an update or a delete, so a per-table verb set (project_created, invoice_created, ...)
-- would restate both and would have to grow with every table added - the audit catalogue
-- would become a second, worse copy of the schema. The generic three, plus a named verb
-- wherever the verb carries meaning the columns cannot, is the smaller and stabler set.
--
-- The session verbs are the num_nonnulls(target_table, target_id) = 0 case that the
-- logs_target_complete constraint allows on purpose: a login is a real entry with no
-- object.
--
-- status_changed exists because DATAMODEL.md 2.7 decides that project status history lives
-- in logs rather than in a table of its own. It is a distinct code and not record_updated
-- so that "the status history of this project" is an indexed lookup rather than a jsonb
-- comparison of before_data against after_data.
--
-- Note what is absent: there is no absence_requested or absence_approved, although the
-- actions.code comment offers absence_approved as an example. Absence status changes go to
-- absence_status_history instead, because RF-AUS-13 restricts who may read the detail of a
-- permit and routing them through the general log would mean every query over logs has to
-- remember to exclude target_table = 'absences' or leak it. That comment's examples predate
-- the decision.

INSERT INTO actions (code, label) VALUES
    ('record_created',      'Registro creado'),
    ('record_updated',      'Registro modificado'),
    ('record_deleted',      'Registro eliminado'),
    ('status_changed',      'Cambio de estatus'),
    ('user_login',          'Inicio de sesión'),
    ('user_login_failed',   'Intento de inicio de sesión fallido'),
    ('user_logout',         'Cierre de sesión'),
    ('permission_granted',  'Permiso otorgado a un rol'),
    ('permission_revoked',  'Permiso retirado a un rol'),
    ('file_uploaded',       'Archivo subido'),
    ('file_downloaded',     'Archivo descargado'),
    ('share_token_created', 'Enlace de solo lectura emitido'),
    ('share_token_revoked', 'Enlace de solo lectura revocado')
ON CONFLICT (code) DO NOTHING;


-- 8. The two grants that are definitions rather than configuration
--
-- The role-permissions migration left every grant to coordination, citing RF-USR-05. That
-- stands for `worker` and `area_lead`, whose permissions are a policy decision and stay
-- empty here. Two grants are not policy:
--
--   `admin` gets everything, because it is the role that configures the others. Leaving it
--   empty is the bootstrap deadlock described at the top of this file - an authorisation
--   model nobody can administer is equivalent to no authorisation model, since the first
--   operator to hit it will work around it in code.
--
--   `finance` gets finance.read and nothing else, because that grant IS the role.
--   RF-USR-08 defines it as transversal read-only access to financial information; a
--   `finance` role without finance.read is a name with no meaning, and any other
--   permission on it would contradict the requirement rather than configure it.
--
-- SELECT rather than literal ids: both sides are identity columns, so the ids depend on
-- insertion order and are not knowable when this file is written.

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r CROSS JOIN permissions p
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'finance.read'
WHERE r.name = 'finance'
ON CONFLICT DO NOTHING;


-- Down Migration

-- Every DELETE below is guarded by NOT EXISTS against the tables that reference it.
--
-- The unguarded version reads better and is wrong: once anything real exists, a catalogue
-- row is referenced by a NOT NULL foreign key, so the DELETE raises and the whole rollback
-- fails - leaving the database on this migration with no way off it except by hand. The
-- guard removes exactly the rows that are still untouched, which is the honest reversal: a
-- scheme that already has people on it is data now, not seed.
--
-- The consequence is that this Down is not always total, and that is deliberate. Compare
-- with absence-types-and-balances, whose Down is lossy in the other direction because the
-- old shape could not hold the new rows.

DELETE FROM role_permissions rp
USING roles r
WHERE rp.role_id = r.id AND r.name IN ('admin', 'finance');

DELETE FROM actions a
WHERE a.code IN ('record_created', 'record_updated', 'record_deleted', 'status_changed',
                 'user_login', 'user_login_failed', 'user_logout',
                 'permission_granted', 'permission_revoked',
                 'file_uploaded', 'file_downloaded',
                 'share_token_created', 'share_token_revoked')
  AND NOT EXISTS (SELECT 1 FROM logs l WHERE l.action_id = a.id);

DELETE FROM absence_types t
WHERE t.code = 'dia_institucional'
  AND NOT EXISTS (SELECT 1 FROM absences ab WHERE ab.absence_type_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM leave_balances lb WHERE lb.absence_type_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM contract_type_entitlements cte WHERE cte.absence_type_id = t.id);

DELETE FROM event_types et
WHERE et.code IN ('horario', 'proyecto', 'ausencia', 'festivo')
  AND NOT EXISTS (SELECT 1 FROM events e WHERE e.event_type_id = et.id);

DELETE FROM areas a
WHERE a.name IN ('Secretaría Particular', 'Producción Audiovisual', 'Diseño Gráfico',
                 'Diseño Web', 'Administración', 'Imprenta', 'Impresión')
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.primary_area_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM area_members am WHERE am.area_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM folder_areas fa WHERE fa.area_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM event_participants ep WHERE ep.area_id = a.id);

DELETE FROM contract_types ct
WHERE ct.name IN ('Honorarios', 'Eventual', 'Base de confianza', 'Base sindicalizada')
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.contract_type_id = ct.id)
  AND NOT EXISTS (SELECT 1 FROM contract_type_entitlements cte WHERE cte.contract_type_id = ct.id);

DELETE FROM roles r
WHERE r.name IN ('worker', 'area_lead', 'admin', 'finance')
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id);

DROP INDEX IF EXISTS uq_contract_types_name;
DROP INDEX IF EXISTS uq_areas_name;
