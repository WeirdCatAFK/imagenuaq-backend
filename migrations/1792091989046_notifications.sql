
-- Up Migration
--
-- Sistema universal de notificaciones de ImageUAQ.
--
-- Categorias:
--   calendario, alerta, recordatorio
--
-- Cada usuario recibe su propio registro, incluso cuando
-- una misma notificacion se envia a toda la coordinacion.
--
-- Las notificaciones se conservan durante seis meses.
-- La limpieza se implementara mediante una tarea programada.

CREATE TABLE notifications (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- Usuario que recibe la notificacion.
    user_id bigint NOT NULL,

    -- Categoria funcional.
    category varchar(30) NOT NULL,

    -- Tipo visual utilizado por el frontend.
    type varchar(50) NOT NULL DEFAULT 'generico',

    -- Contenido.
    title varchar(300) NOT NULL,
    message text NOT NULL,

    -- Entidad que origino la notificacion.
    source_type varchar(100),
    source_id bigint,

    -- Identificador para evitar duplicados.
    dedup_key varchar(300),

    -- Historial y lectura.
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    read_at timestamptz,

    CONSTRAINT notifications_category_check
        CHECK (category IN (
            'calendario',
            'alerta',
            'recordatorio'
        )),

    CONSTRAINT notifications_title_check
        CHECK (length(trim(title)) > 0),

    CONSTRAINT notifications_message_check
        CHECK (length(trim(message)) > 0),

    CONSTRAINT notifications_read_at_check
        CHECK (
            read_at IS NULL
            OR read_at >= created_at
        )
);

-- Relacion con los usuarios.
ALTER TABLE notifications
ADD CONSTRAINT fk_notifications_user_id_users_id
FOREIGN KEY (user_id)
REFERENCES users(id);

-- Historial ordenado por fecha.
CREATE INDEX notifications_user_created_idx
ON notifications (user_id, created_at DESC, id DESC);

-- Notificaciones sin leer.
CREATE INDEX notifications_unread_idx
ON notifications (user_id, created_at DESC)
WHERE read_at IS NULL;

-- Limpieza de registros antiguos.
CREATE INDEX notifications_created_at_idx
ON notifications (created_at);

-- Evitar avisos duplicados por usuario.
CREATE UNIQUE INDEX notifications_user_dedup_idx
ON notifications (user_id, dedup_key)
WHERE dedup_key IS NOT NULL;

COMMENT ON TABLE notifications IS
'Notificaciones persistentes por usuario, con retencion de seis meses.';

COMMENT ON COLUMN notifications.category IS
'Categoria funcional: calendario, alerta o recordatorio.';

COMMENT ON COLUMN notifications.type IS
'Tipo visual: alerta, mensaje, proyecto, birthday o generico.';

COMMENT ON COLUMN notifications.dedup_key IS
'Clave de deduplicacion por destinatario y situacion.';

COMMENT ON COLUMN notifications.read_at IS
'NULL cuando la notificacion esta sin leer.';


-- Down Migration

DROP TABLE IF EXISTS notifications;
