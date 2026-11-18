-- El enlace de un formulario público se vuelve a copiar desde la lista (DATAMODEL §2.21). A
-- diferencia de un enlace a una carpeta, este se publica a propósito, así que el token se guarda
-- cifrado con MS_TOKEN_KEY junto al hash. El hash sigue siendo con lo que se busca.

-- Up Migration

ALTER TABLE form_links ADD COLUMN token_enc bytea;

COMMENT ON COLUMN form_links.token_enc IS 'El token cifrado con MS_TOKEN_KEY, para volver a copiar el enlace. NULL en los enlaces creados antes de guardarlo.';

-- Down Migration

ALTER TABLE form_links DROP COLUMN IF EXISTS token_enc;
