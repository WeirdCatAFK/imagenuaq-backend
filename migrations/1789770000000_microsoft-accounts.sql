-- Up Migration

-- `sheets` says which workbook; nothing says who can read it.
--
-- projects-spine gave RF-MIG-01 its registry: a `sheets` row is a Graph drive/item pair,
-- the table inside it, and the format its columns map onto. What that row could not say is
-- WITH WHOSE ACCESS the workbook is read. The only Graph token the codebase knew was one
-- pasted by hand into .env, which expires within the hour and belongs to nobody, so the
-- registry could be filled in but never used.
--
-- The access is delegated, not application-wide. An app-only registration
-- (client-credentials) would read every drive in the tenant under one identity, which is
-- more than this system needs and more than the tenant will grant to a departmental tool.
-- Instead a staff member signs in with their Microsoft account once, and the workbooks
-- they register are read as them: each `microsoft_accounts` row is one such grant, and
-- `sheets.microsoft_account_id` says which grant reads which book. Any number of people
-- may connect, any account may register any number of books, and adding either is a row,
-- not a deploy.
--
-- The refresh token is the credential and it is stored encrypted (AES-256-GCM under
-- MS_TOKEN_KEY in .env, src/utils/crypto.js). Microsoft rotates it on every use, so the
-- column is rewritten each time a book is read; `last_used_at` moves with it. A row is
-- never deleted: `revoked_at` marks a grant that was withdrawn -- by the person here, or
-- by Microsoft when the refresh fails -- so the sheets that depended on it keep saying
-- which account to reconnect. The column name contains `token`, which is what
-- access/orchestration/audit.js redacts by pattern, so the trail never carries it.
--
-- The unique index is on (user_id, ms_object_id) among live rows, not on ms_object_id
-- alone: two staff may each connect the same shared mailbox, and each holds their own
-- token for it. One person reconnecting the same account replaces their token in place.
--
-- `sheets.schema_version_id` loses NOT NULL. projects-spine made a registration and a
-- mapping one act, but there is no endpoint yet that publishes a format to point at, so
-- as written the table could not be inserted into. Registering (which book) and mapping
-- (into what) are separate acts anyway: a book is registered the day the account is
-- connected and mapped the day coordination decides which format it feeds. NULL with an
-- empty `column_map` reads as "registered, not yet mapped", and RF-MIG-02's import refuses
-- such a row rather than guessing.
--
-- The two permission codes follow routes/areas.js: one read code and one write code for
-- the feature, mounted per router block. Both are granted to `admin` here rather than
-- waiting for `npm run admin:create` to re-run, for the reason that script exists -- an
-- admin without access to a router nobody else has access to either is a lockout.
--
-- DATAMODEL.md 2.10.


-- 1. The grant

CREATE TABLE microsoft_accounts (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id           bigint NOT NULL REFERENCES users (id),
    -- El claim `oid` del id_token: estable para la cuenta, sobrevive cambios de correo
    ms_object_id      varchar(64) NOT NULL,
    tenant_id         varchar(64) NOT NULL,
    email             varchar(320),
    display_name      varchar(300),
    refresh_token_enc bytea NOT NULL,
    scopes            text NOT NULL,
    connected_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at      timestamptz,
    revoked_at        timestamptz
);
COMMENT ON TABLE microsoft_accounts IS 'RF-MIG-01: la cuenta Microsoft con cuyo acceso se leen los libros registrados. Una fila por persona y cuenta; se revoca, no se borra.';
COMMENT ON COLUMN microsoft_accounts.ms_object_id IS 'Claim oid del id_token. Identifica la cuenta aunque cambie el correo.';
COMMENT ON COLUMN microsoft_accounts.tenant_id IS 'Claim tid del id_token. Un tenant de organizacion, o el de cuentas personales.';
COMMENT ON COLUMN microsoft_accounts.refresh_token_enc IS 'Refresh token cifrado con MS_TOKEN_KEY. Microsoft lo rota en cada uso, asi que se reescribe al leer.';
COMMENT ON COLUMN microsoft_accounts.scopes IS 'Los permisos delegados que la persona concedio, tal como los devolvio Microsoft';
COMMENT ON COLUMN microsoft_accounts.revoked_at IS 'Retirado por la persona o por Microsoft (refresh rechazado). Los libros que dependian de el siguen apuntando aqui.';

CREATE UNIQUE INDEX uq_microsoft_accounts_live
    ON microsoft_accounts (user_id, ms_object_id)
    WHERE revoked_at IS NULL;
CREATE INDEX idx_microsoft_accounts_user_id ON microsoft_accounts (user_id);


-- 2. Which grant reads which book, and registering before mapping

ALTER TABLE sheets
    ALTER COLUMN schema_version_id DROP NOT NULL,
    ADD COLUMN microsoft_account_id bigint NOT NULL REFERENCES microsoft_accounts (id),
    ADD COLUMN registered_by        bigint REFERENCES users (id);
COMMENT ON COLUMN sheets.schema_version_id IS 'Formato destino. NULL = registrado pero sin mapear; la importacion lo rechaza en vez de adivinar.';
COMMENT ON COLUMN sheets.microsoft_account_id IS 'Con el acceso de que cuenta se lee este libro';
COMMENT ON COLUMN sheets.registered_by IS 'Quien lo registro';

CREATE INDEX idx_sheets_microsoft_account_id ON sheets (microsoft_account_id) WHERE deleted_at IS NULL;


-- 3. Permissions and the admin grant

INSERT INTO permissions (code, label, description) VALUES
    ('spreadsheet.read',  'Ver libros de Excel registrados',
     'RF-MIG-01: consultar las cuentas Microsoft conectadas y los libros registrados, y leer sus encabezados'),
    ('spreadsheet.write', 'Conectar cuentas Microsoft y registrar libros',
     'RF-MIG-01, RF-MIG-02: conectar o desconectar una cuenta Microsoft propia y registrar o quitar libros')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.code IN ('spreadsheet.read', 'spreadsheet.write')
 WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;


-- 4. Audit actions. Sheets themselves use record_created / record_deleted.

INSERT INTO actions (code, label) VALUES
    ('microsoft_account_connected', 'Cuenta Microsoft conectada'),
    ('microsoft_account_revoked',   'Cuenta Microsoft desconectada')
ON CONFLICT (code) DO NOTHING;


-- Down Migration

DELETE FROM actions WHERE code IN ('microsoft_account_connected', 'microsoft_account_revoked');

DELETE FROM role_permissions
 WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('spreadsheet.read', 'spreadsheet.write'));
DELETE FROM permissions WHERE code IN ('spreadsheet.read', 'spreadsheet.write');

DROP INDEX IF EXISTS idx_sheets_microsoft_account_id;
ALTER TABLE sheets
    DROP COLUMN IF EXISTS registered_by,
    DROP COLUMN IF EXISTS microsoft_account_id;

-- A registered-but-unmapped book has no place in the previous shape, so it goes rather
-- than blocking the constraint.
DELETE FROM sheets WHERE schema_version_id IS NULL;
ALTER TABLE sheets ALTER COLUMN schema_version_id SET NOT NULL;
COMMENT ON COLUMN sheets.schema_version_id IS NULL;

DROP TABLE IF EXISTS microsoft_accounts;
