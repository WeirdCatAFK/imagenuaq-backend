-- Up Migration

-- The bitácora could say who, when and to what, but not from where.
--
-- §5.6 wired the audit trail up and it records `user_id`. That answers "who deleted this
-- invoice" and not "what did Diseño Gráfico do last week", which is the shape the reading
-- actually takes:
--
--   RF-USR-04 — a responsable de área consults the work of everyone under them. A bitácora
--               they can only filter by naming each person one at a time is not that.
--   RF-USR-03 — every member of an area sees their colleagues' work. The area is the unit
--               the requirement is written in, so it should be the unit the trail indexes.
--
-- The area could be derived at read time instead, by joining `logs` to `area_members`. It
-- would be wrong. That join answers where the person is **now**, and a trail exists to say
-- what was true **then**: move somebody from Imprenta to Diseño and every action they ever
-- took retroactively becomes Diseño's. Denormalising is the point here, not a shortcut --
-- the same reason `before_data` copies the row instead of pointing at it.
--
-- Nullable, and it has to be. `user_id` is nullable already (a failed login on an address
-- that matches no account has nobody to attribute), a user may have no primary area, and
-- every row written before this migration has no area to backfill from that would not be
-- the retroactive lie described above. NULL here means "not recorded", never "no area".
--
-- Rejected: NOT NULL with a default of some "sin área" row. It would make the unrecorded
-- rows indistinguishable from the ones that genuinely belong to no area, and there is no
-- way back from that once the trail has grown.
--
-- Which area, given that `area_members` is many-to-many: `users.primary_area_id`, the one
-- single-valued answer the schema has. Somebody who belongs to two areas and acts on the
-- second is attributed to their primary one. That is a known imprecision and it is the
-- honest limit of attributing an action to a *person's* area rather than to the affected
-- record's -- which is the better question and is unanswerable generically, because the
-- affected record is a different table in every row.

ALTER TABLE logs ADD COLUMN area_id bigint REFERENCES areas (id);

COMMENT ON COLUMN logs.area_id IS 'Area the actor belonged to when the action happened, from users.primary_area_id. Recorded, not derived: joining area_members at read time would answer where they are now. NULL = not recorded.';

-- Partial, like idx_logs_target above it: the objectless and unattributed rows are a real
-- share of the table -- every user_login_failed on an unknown address is one -- and they
-- are never what an area filter is looking for.
CREATE INDEX idx_logs_area_id ON logs (area_id, created_at DESC)
    WHERE area_id IS NOT NULL;


-- Closes the reading half of DATAMODEL.md 5.6.


-- Down Migration

DROP INDEX IF EXISTS idx_logs_area_id;

ALTER TABLE logs DROP COLUMN IF EXISTS area_id;
