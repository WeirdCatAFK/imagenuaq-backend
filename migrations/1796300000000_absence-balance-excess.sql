-- Up Migration

-- Going over a balance is warned about and never refused (RF-AUS-07), so an authorised absence may
-- leave more used than granted. Until now nothing created balances, so the old check never ran.
ALTER TABLE leave_balances DROP CONSTRAINT lb_used_within;
ALTER TABLE leave_balances ADD CONSTRAINT lb_used_nonneg CHECK (used >= 0);

-- Down Migration

ALTER TABLE leave_balances DROP CONSTRAINT lb_used_nonneg;
UPDATE leave_balances SET used = granted WHERE used > granted;
ALTER TABLE leave_balances ADD CONSTRAINT lb_used_within CHECK (used >= 0 AND used <= granted);
