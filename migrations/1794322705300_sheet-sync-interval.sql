-- Per-spreadsheet auto-sync interval (RF-MIG-01). NULL = manual only, a positive
-- integer = minutes between automatic imports.  The scheduler job checks every five
-- minutes and imports sheets whose interval has elapsed since last_imported_at.

alter table sheets
  add column sync_interval_minutes smallint
    check (sync_interval_minutes is null or sync_interval_minutes > 0);

comment on column sheets.sync_interval_minutes
  is 'NULL = manual only. Positive integer = minutes between automatic imports.';
