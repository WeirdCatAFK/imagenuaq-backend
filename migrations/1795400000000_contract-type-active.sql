-- Up Migration

-- Deleting a contract type deactivates it (RF-AUS-04). The people on it and the caps it granted
-- are history, so the row stays and only leaves the pickers. Creating the same name again
-- reactivates it.
ALTER TABLE contract_types ADD COLUMN is_active boolean NOT NULL DEFAULT true;

-- Down Migration

ALTER TABLE contract_types DROP COLUMN is_active;
