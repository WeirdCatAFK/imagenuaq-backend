-- Up Migration

ALTER TABLE days_off RENAME COLUMN allotted TO amount;

-- Down Migration

ALTER TABLE days_off RENAME COLUMN amount TO allotted;
