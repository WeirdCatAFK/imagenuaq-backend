-- Up Migration
CREATE TABLE IF NOT EXISTS data_types (
  id BIGSERIAL PRIMARY KEY,

  code VARCHAR(50) NOT NULL UNIQUE,

  name VARCHAR(100) NOT NULL,

  base_type VARCHAR(30) NOT NULL,

  properties JSONB NOT NULL DEFAULT '{}'::jsonb,

  is_active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration