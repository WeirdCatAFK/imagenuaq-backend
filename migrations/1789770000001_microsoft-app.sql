-- Up Migration

-- The Azure app registration was the one piece of the Microsoft sign-in that lived in .env.
--
-- microsoft-accounts made every *grant* a row, so connecting a person's account never
-- touches the server. The application those grants are made to -- the tenant, client id
-- and client secret Microsoft issues once in the Entra portal -- still had to be typed
-- into .env and the server restarted, which is a developer's act, not coordination's. The
-- registration itself cannot move (Microsoft has no API for creating one), but its three
-- values can, and this is the row they move to.
--
-- One row, not a settings table. A generic key/value store would be a mechanism invented
-- for a single use, with the shape of every future setting decided by whoever adds the
-- second one under time pressure. This table is the registration and nothing else; a
-- `CHECK (id = 1)` is what makes it a singleton, so an INSERT that would make a second
-- registration fails rather than leaving the reader to pick. If a second configuration of
-- this kind arrives, that is the moment to generalise, with two examples in hand.
--
-- The secret is sealed under MS_TOKEN_KEY like the refresh tokens (src/utils/crypto.js),
-- and the column name contains `secret`, which audit.js redacts by pattern. The client id
-- and tenant are not secrets -- the client id is in every authorize URL the browser sees --
-- and are stored plain so the settings screen can show what is configured.
--
-- .env stays as a fallback: orchestration/microsoft.js reads this row first and MS_CLIENT_ID
-- / MS_CLIENT_SECRET / MS_TENANT_ID when it is absent, so a deployment that prefers to
-- keep the registration out of the database can, and the test suite needs no row.
--
-- DATAMODEL.md 2.10.

CREATE TABLE microsoft_app (
    id                smallint PRIMARY KEY DEFAULT 1,
    tenant_id         varchar(64) NOT NULL DEFAULT 'common',
    client_id         varchar(64) NOT NULL,
    client_secret_enc bytea NOT NULL,
    updated_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by        bigint REFERENCES users (id),
    CONSTRAINT microsoft_app_singleton CHECK (id = 1)
);
COMMENT ON TABLE microsoft_app IS 'RF-MIG-01: el registro de aplicacion de Azure con el que se inicia sesion en Microsoft. Una sola fila; si no existe se leen MS_* de .env.';
COMMENT ON COLUMN microsoft_app.tenant_id IS 'common (cualquier cuenta) o el id del tenant de la UAQ';
COMMENT ON COLUMN microsoft_app.client_id IS 'Application (client) ID del portal de Entra. No es secreto: viaja en cada URL de autorizacion.';
COMMENT ON COLUMN microsoft_app.client_secret_enc IS 'Client secret cifrado con MS_TOKEN_KEY. Nunca se devuelve; solo si esta puesto.';


-- Down Migration

DROP TABLE IF EXISTS microsoft_app;
