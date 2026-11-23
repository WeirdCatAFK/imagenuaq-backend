-- Finanzas sin etapas (RF-FIN-03, RF-FIN-07, RF-FIN-10, RF-FIN-12, RF-FIN-16).
--
-- **Se sube y, si está mal, se pide corregir.** Cotizaciones, facturas, oficios y recibos dejan
-- de tener estatus con fecha por paso: finanzas no lleva esos trámites en el sistema. Cualquier
-- registro (también un pago) puede llevar una solicitud de corrección con su nota; quien lo subió
-- recibe el aviso y al editarlo la solicitud se borra. La bitácora guarda cada solicitud.
--
-- **Proyecto completo para finanzas.** `projects.finance_completed_at` lo saca de la lista de
-- trabajo y le apaga los indicadores; sigue editable y se puede reabrir.
--
-- Las cotizaciones rechazadas se borran (lógico) antes de soltar el estatus, para que no empiecen
-- a contar como cotización vigente. Los recibos ganan `deleted_at`: uno cancelado queda borrado.
-- Las acciones de estatus siguen en el catálogo porque la bitácora las cita (RF-USR-07).

-- Up Migration

UPDATE quotes SET deleted_at = coalesce(decided_at, CURRENT_TIMESTAMP)
 WHERE status = 'rejected' AND deleted_at IS NULL;

ALTER TABLE quotes
    DROP CONSTRAINT quotes_status_valid,
    DROP CONSTRAINT quotes_decision_complete,
    DROP COLUMN status,
    DROP COLUMN in_review_at,
    DROP COLUMN decided_at,
    DROP COLUMN decided_by,
    DROP COLUMN decision_comment;

ALTER TABLE invoices
    DROP CONSTRAINT invoices_status_valid,
    DROP COLUMN status,
    DROP COLUMN payment_folio,
    DROP COLUMN sent_at,
    DROP COLUMN in_payment_at,
    DROP COLUMN paid_at;

ALTER TABLE oficios
    DROP CONSTRAINT oficios_status_valid,
    DROP COLUMN status,
    DROP COLUMN sent_at,
    DROP COLUMN signed_at,
    DROP COLUMN answered_at,
    DROP COLUMN paid_at;

ALTER TABLE receipts ADD COLUMN deleted_at timestamptz;
UPDATE receipts SET deleted_at = cancelled_at WHERE status = 'cancelled';

ALTER TABLE receipts
    DROP CONSTRAINT receipts_status_valid,
    DROP CONSTRAINT receipts_validator_not_creator,
    DROP CONSTRAINT receipts_validated_before_issue,
    DROP COLUMN status,
    DROP COLUMN submitted_at,
    DROP COLUMN validated_by,
    DROP COLUMN validated_at,
    DROP COLUMN validation_comment,
    DROP COLUMN issued_at,
    DROP COLUMN paid_at,
    DROP COLUMN cancelled_at;

DROP INDEX idx_receipts_project;
CREATE INDEX idx_receipts_project ON receipts (project_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE quotes IS 'RF-FIN-01 to RF-FIN-04: uploaded, never decided; finance asks for a correction instead.';
COMMENT ON TABLE oficios IS 'RF-FIN-11: a charge to the requesting entity, grouping invoices of one project.';
COMMENT ON TABLE receipts IS 'RF-FIN-15: coordination charging the requesting entity.';

ALTER TABLE quotes
    ADD COLUMN correction_note text,
    ADD COLUMN correction_requested_at timestamptz,
    ADD COLUMN correction_requested_by bigint REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE invoices
    ADD COLUMN correction_note text,
    ADD COLUMN correction_requested_at timestamptz,
    ADD COLUMN correction_requested_by bigint REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE oficios
    ADD COLUMN correction_note text,
    ADD COLUMN correction_requested_at timestamptz,
    ADD COLUMN correction_requested_by bigint REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE payments
    ADD COLUMN correction_note text,
    ADD COLUMN correction_requested_at timestamptz,
    ADD COLUMN correction_requested_by bigint REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE receipts
    ADD COLUMN correction_note text,
    ADD COLUMN correction_requested_at timestamptz,
    ADD COLUMN correction_requested_by bigint REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE projects
    ADD COLUMN finance_completed_at timestamptz,
    ADD COLUMN finance_completed_by bigint REFERENCES users (id) ON DELETE SET NULL;
COMMENT ON COLUMN projects.finance_completed_at IS 'Finance marked it complete: out of the working list, no flags. NULL = open.';

CREATE OR REPLACE VIEW finance_files AS
    SELECT file_id FROM quotes WHERE file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT file_id FROM invoices WHERE file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT stamped_file_id FROM oficios WHERE stamped_file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT proof_file_id FROM payments WHERE proof_file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT file_id FROM receipts WHERE file_id IS NOT NULL AND deleted_at IS NULL;

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'finance.validate');
DELETE FROM permissions WHERE code = 'finance.validate';

INSERT INTO actions (code, label) VALUES
    ('correction_requested',      'Corrección solicitada'),
    ('receipt_deleted',           'Recibo eliminado'),
    ('project_finance_completed', 'Proyecto completo para finanzas'),
    ('project_finance_reopened',  'Proyecto reabierto para finanzas')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM logs
WHERE action_id IN (SELECT id FROM actions WHERE code IN
  ('correction_requested', 'receipt_deleted', 'project_finance_completed', 'project_finance_reopened'));
DELETE FROM actions WHERE code IN
  ('correction_requested', 'receipt_deleted', 'project_finance_completed', 'project_finance_reopened');

INSERT INTO permissions (code, label, description) VALUES
    ('finance.validate', 'Validar cobros',
     'RF-FIN-16: dar el visto bueno de un recibo referenciado antes de emitirlo; nunca a uno propio')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'finance.validate'
WHERE r.name IN ('admin', 'finance')
ON CONFLICT DO NOTHING;

ALTER TABLE projects DROP COLUMN finance_completed_by, DROP COLUMN finance_completed_at;

ALTER TABLE quotes DROP COLUMN correction_requested_by, DROP COLUMN correction_requested_at, DROP COLUMN correction_note;
ALTER TABLE invoices DROP COLUMN correction_requested_by, DROP COLUMN correction_requested_at, DROP COLUMN correction_note;
ALTER TABLE oficios DROP COLUMN correction_requested_by, DROP COLUMN correction_requested_at, DROP COLUMN correction_note;
ALTER TABLE payments DROP COLUMN correction_requested_by, DROP COLUMN correction_requested_at, DROP COLUMN correction_note;
ALTER TABLE receipts DROP COLUMN correction_requested_by, DROP COLUMN correction_requested_at, DROP COLUMN correction_note;

ALTER TABLE receipts
    ADD COLUMN status varchar(20) NOT NULL DEFAULT 'draft',
    ADD COLUMN submitted_at timestamptz,
    ADD COLUMN validated_by bigint REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN validated_at timestamptz,
    ADD COLUMN validation_comment text,
    ADD COLUMN issued_at timestamptz,
    ADD COLUMN paid_at timestamptz,
    ADD COLUMN cancelled_at timestamptz;
UPDATE receipts SET status = 'cancelled', cancelled_at = deleted_at WHERE deleted_at IS NOT NULL;
ALTER TABLE receipts
    ADD CONSTRAINT receipts_status_valid CHECK (status IN
        ('draft', 'pending_validation', 'validated', 'issued', 'paid', 'cancelled')),
    ADD CONSTRAINT receipts_validator_not_creator CHECK (validated_by IS DISTINCT FROM created_by OR validated_by IS NULL),
    ADD CONSTRAINT receipts_validated_before_issue CHECK (
        status NOT IN ('validated', 'issued', 'paid') OR validated_at IS NOT NULL);

DROP VIEW finance_files;
CREATE VIEW finance_files AS
    SELECT file_id FROM quotes WHERE file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT file_id FROM invoices WHERE file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT stamped_file_id FROM oficios WHERE stamped_file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT proof_file_id FROM payments WHERE proof_file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT file_id FROM receipts WHERE file_id IS NOT NULL;

DROP INDEX idx_receipts_project;
ALTER TABLE receipts DROP COLUMN deleted_at;
CREATE INDEX idx_receipts_project ON receipts (project_id);

ALTER TABLE oficios
    ADD COLUMN status varchar(20) NOT NULL DEFAULT 'issued',
    ADD COLUMN sent_at timestamptz,
    ADD COLUMN signed_at timestamptz,
    ADD COLUMN answered_at timestamptz,
    ADD COLUMN paid_at timestamptz,
    ADD CONSTRAINT oficios_status_valid CHECK (status IN ('issued', 'sent', 'signed', 'answered', 'paid'));

ALTER TABLE invoices
    ADD COLUMN status varchar(20) NOT NULL DEFAULT 'uploaded',
    ADD COLUMN payment_folio varchar(100),
    ADD COLUMN sent_at timestamptz,
    ADD COLUMN in_payment_at timestamptz,
    ADD COLUMN paid_at timestamptz,
    ADD CONSTRAINT invoices_status_valid CHECK (status IN ('uploaded', 'sent', 'in_payment', 'paid'));

ALTER TABLE quotes
    ADD COLUMN status varchar(20) NOT NULL DEFAULT 'issued',
    ADD COLUMN in_review_at timestamptz,
    ADD COLUMN decided_at timestamptz,
    ADD COLUMN decided_by bigint REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN decision_comment text,
    ADD CONSTRAINT quotes_status_valid CHECK (status IN ('issued', 'in_review', 'approved', 'rejected')),
    ADD CONSTRAINT quotes_decision_complete CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL));
