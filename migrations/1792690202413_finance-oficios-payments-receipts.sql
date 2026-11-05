-- Oficios, pagos y recibos referenciados (RF-FIN-10 a RF-FIN-17). Segunda mitad de I9.
--
-- **El oficio cobra a la entidad.** Pertenece a un proyecto y agrupa algunas de sus facturas; una
-- factura va en un solo oficio (`invoices.oficio_id`). Su monto se captura a mano y la API avisa si
-- no coincide con la suma de sus facturas, porque lo que se cobra no siempre es lo facturado. Los
-- pasos solo avanzan, pueden saltarse, y cada paso alcanzado guarda su fecha (RF-FIN-12); «sin
-- respuesta» se mide desde `sent_at` (RF-FIN-13).
--
-- **El pago va en los dos sentidos.** `incoming` es la entidad pagando un oficio; `outgoing`, la
-- universidad pagando la factura de un proveedor. Los dos llevan el folio de rastreo del sistema
-- financiero y su comprobante; un pago sin folio es el pendiente de RF-FIN-14. Un pago nunca mueve
-- estatus: los pagos parciales y tardíos son lo normal, y marcar pagado es decisión de finanzas.
--
-- **El recibo referenciado** (RF-FIN-15, RF-FIN-16) es el otro esquema de cobro: la coordinación
-- cobra a la entidad solicitante y alguien distinto de quien lo capturó lo valida antes de
-- emitirlo. Un rechazo lo devuelve a borrador; por eso no hay estatus `rejected`. No se borra: se
-- cancela.
--
-- `finance_files` se redefine para que los archivos de estas tablas también sigan la retención de
-- finanzas.

-- Up Migration

CREATE TABLE oficios (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id      bigint NOT NULL REFERENCES projects (id),
    folio           varchar(100) NOT NULL,
    recipient       varchar(300),
    amount          numeric(12, 2) NOT NULL,
    note            text,
    stamped_file_id bigint REFERENCES files (id),
    status          varchar(20) NOT NULL DEFAULT 'issued',
    sent_at         timestamptz,
    signed_at       timestamptz,
    answered_at     timestamptz,
    paid_at         timestamptz,
    created_by      bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at      timestamptz,
    CONSTRAINT oficios_status_valid CHECK (status IN ('issued', 'sent', 'signed', 'answered', 'paid')),
    CONSTRAINT oficios_amount_positive CHECK (amount >= 0)
);

CREATE INDEX idx_oficios_project ON oficios (project_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_oficios_folio ON oficios (upper(folio)) WHERE deleted_at IS NULL;

COMMENT ON TABLE oficios IS 'RF-FIN-11 to RF-FIN-13: a charge to the requesting entity, grouping invoices of one project.';

ALTER TABLE invoices ADD COLUMN oficio_id bigint REFERENCES oficios (id);
CREATE INDEX idx_invoices_oficio ON invoices (oficio_id) WHERE oficio_id IS NOT NULL;
COMMENT ON COLUMN invoices.oficio_id IS 'The one oficio the invoice was sent in.';

CREATE TABLE payments (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id     bigint NOT NULL REFERENCES projects (id),
    direction      varchar(10) NOT NULL,
    oficio_id      bigint REFERENCES oficios (id),
    invoice_id     bigint REFERENCES invoices (id),
    provider_id    bigint REFERENCES providers (id),
    amount         numeric(12, 2) NOT NULL,
    paid_on        date,
    tracking_folio varchar(100),
    proof_file_id  bigint REFERENCES files (id),
    note           text,
    created_by     bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at     timestamptz,
    CONSTRAINT payments_amount_positive CHECK (amount >= 0),
    CONSTRAINT payments_direction_target CHECK (
        (direction = 'incoming' AND oficio_id IS NOT NULL AND invoice_id IS NULL)
        OR (direction = 'outgoing' AND invoice_id IS NOT NULL AND oficio_id IS NULL))
);

CREATE INDEX idx_payments_project ON payments (project_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE payments IS 'RF-FIN-14: incoming pays an oficio, outgoing pays a provider invoice. Never moves a status.';
COMMENT ON COLUMN payments.tracking_folio IS 'Folio of the university financial system backing the payment. NULL = not delivered yet.';

CREATE TABLE receipts (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id         bigint NOT NULL REFERENCES projects (id),
    quote_id           bigint REFERENCES quotes (id),
    requester          varchar(300),
    amount             numeric(12, 2) NOT NULL,
    reference          varchar(100),
    concept            text,
    file_id            bigint REFERENCES files (id),
    status             varchar(20) NOT NULL DEFAULT 'draft',
    submitted_at       timestamptz,
    validated_by       bigint REFERENCES users (id) ON DELETE SET NULL,
    validated_at       timestamptz,
    validation_comment text,
    issued_at          timestamptz,
    paid_at            timestamptz,
    cancelled_at       timestamptz,
    created_by         bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at         timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT receipts_status_valid CHECK (status IN
        ('draft', 'pending_validation', 'validated', 'issued', 'paid', 'cancelled')),
    CONSTRAINT receipts_amount_positive CHECK (amount >= 0),
    CONSTRAINT receipts_validator_not_creator CHECK (validated_by IS DISTINCT FROM created_by OR validated_by IS NULL),
    CONSTRAINT receipts_validated_before_issue CHECK (
        status NOT IN ('validated', 'issued', 'paid') OR validated_at IS NOT NULL)
);

CREATE INDEX idx_receipts_project ON receipts (project_id);

COMMENT ON TABLE receipts IS 'RF-FIN-15, RF-FIN-16: coordination charging the requesting entity, validated by someone else before it is issued.';

CREATE OR REPLACE VIEW finance_files AS
    SELECT file_id FROM quotes WHERE file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT file_id FROM invoices WHERE file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT stamped_file_id FROM oficios WHERE stamped_file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT proof_file_id FROM payments WHERE proof_file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT file_id FROM receipts WHERE file_id IS NOT NULL;

INSERT INTO permissions (code, label, description) VALUES
    ('finance.validate', 'Validar cobros',
     'RF-FIN-16: dar el visto bueno de un recibo referenciado antes de emitirlo; nunca a uno propio')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'finance.validate'
WHERE r.name IN ('admin', 'finance')
ON CONFLICT DO NOTHING;

INSERT INTO actions (code, label) VALUES
    ('oficio_created',         'Oficio registrado'),
    ('oficio_updated',         'Oficio modificado'),
    ('oficio_status_changed',  'Oficio avanzó de paso'),
    ('oficio_deleted',         'Oficio eliminado'),
    ('invoice_status_changed', 'Factura avanzó de paso'),
    ('payment_created',        'Pago registrado'),
    ('payment_updated',        'Pago modificado'),
    ('payment_deleted',        'Pago eliminado'),
    ('receipt_created',        'Recibo registrado'),
    ('receipt_updated',        'Recibo modificado'),
    ('receipt_submitted',      'Recibo enviado a validar'),
    ('receipt_validated',      'Recibo validado'),
    ('receipt_rejected',       'Recibo devuelto'),
    ('receipt_status_changed', 'Recibo avanzó de paso')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM logs
WHERE action_id IN (SELECT id FROM actions WHERE code IN
  ('oficio_created', 'oficio_updated', 'oficio_status_changed', 'oficio_deleted',
   'invoice_status_changed', 'payment_created', 'payment_updated', 'payment_deleted',
   'receipt_created', 'receipt_updated', 'receipt_submitted', 'receipt_validated',
   'receipt_rejected', 'receipt_status_changed'));

DELETE FROM actions WHERE code IN
  ('oficio_created', 'oficio_updated', 'oficio_status_changed', 'oficio_deleted',
   'invoice_status_changed', 'payment_created', 'payment_updated', 'payment_deleted',
   'receipt_created', 'receipt_updated', 'receipt_submitted', 'receipt_validated',
   'receipt_rejected', 'receipt_status_changed');

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'finance.validate');

DELETE FROM permissions WHERE code = 'finance.validate';

DROP VIEW finance_files;
CREATE VIEW finance_files AS
    SELECT file_id FROM quotes WHERE file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT file_id FROM invoices WHERE file_id IS NOT NULL AND deleted_at IS NULL;

DROP TABLE receipts;
DROP TABLE payments;
DROP INDEX idx_invoices_oficio;
ALTER TABLE invoices DROP COLUMN oficio_id;
DROP TABLE oficios;
