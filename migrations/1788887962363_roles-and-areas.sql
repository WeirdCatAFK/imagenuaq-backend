-- Up Migration

-- The organisation had no shape.
--
-- `areas` was a flat catalogue: seven rows, none of them related to any other. Two
-- requirements need the relation between them to be data:
--
--   RF-USR-09 — new *areas and coordinations* are created without development work,
--               "dado que la estructura organizacional crece". A coordination is not a
--               different kind of thing from an area; it is an area with areas under it.
--               With no way to say which is under which, "dar de alta una coordinación"
--               and "dar de alta un área" are the same operation and the difference lives
--               only in whoever remembers it.
--   RF-USR-04 — area leads and coordination consult the work of "todos los usuarios a su
--               cargo". That is a *subtree* of areas, not one area: a coordination with
--               three areas under it is at their head, and today the query that would
--               answer it cannot be written.
--
-- `roles.description` comes along in the same migration for a smaller reason: the role
-- catalogue is edited from the application now (four seeded names, more to come), and a
-- name of at most 50 characters cannot say what a role is for. `text`, matching
-- `areas.description` and `permissions.description`, rather than a varchar with an
-- invented ceiling.


-- 1. The role catalogue gets somewhere to explain itself

ALTER TABLE roles ADD COLUMN description text;


-- 2. Which area hangs under which
--
-- One row per area that HAS a parent. An area with no row here is a root, so the table
-- stores only the exceptions -- most areas answer to nobody in particular, and a
-- `parent_area_id` column on `areas` would have been seven NULLs and a join anyway.
--
-- The primary key is `child_area_id` ALONE, and that is the whole design. A composite
-- (parent, child) key -- the obvious shape, and the one this migration was first drafted
-- with -- permits an area to have several parents. The result is not a tree, and the
-- organisation chart RF-USR-09 implies then has no rendering: the subtree under a
-- twice-parented area is either drawn twice, so that the same people appear in two places
-- with no indication that they are one team, or drawn once and the chart silently lies
-- about one of the two lines of authority. Making the child the key means the database
-- refuses the second parent instead of the frontend having to choose which one to believe.
--
-- Rejected: a `level` column to place the node on the diagram. Depth is not a fact about
-- an area, it is a consequence of where the area currently hangs, and re-parenting one
-- subtree would have to rewrite `level` on every descendant -- an operation nobody would
-- remember to perform, leaving a chart that renders confidently at the wrong depth. It is
-- computed by a recursive CTE at read time (`getAreaTreeRows` in access/resources/
-- query.js). Contrast `file_locations` in access/primitives/storage.js, where placement IS
-- recorded: which disk holds a blob is a choice that nothing can re-derive.
--
-- Cycles deeper than one hop (A under B under A) are NOT constrained here. Expressing that
-- in SQL needs a trigger or a materialised transitive closure, and both cost every write to
-- guard against something only a hand-written UPDATE can produce. Two cheaper defences
-- instead: `Areas.setParent()` in access/orchestration/areas.js refuses a parent that is
-- already a descendant of the child, and the read query carries the recursive CTE's CYCLE
-- clause (Postgres 14+; POSTGRES_VERSION is 18), so a cycle introduced through psql
-- truncates that branch of the chart rather than hanging the request forever. Whoever adds
-- a second write path to this table owns the same check.
--
-- ON DELETE CASCADE on both sides. Deleting an area removes the link to its parent and the
-- links to its children, which promotes those children to roots -- still drawable. The
-- alternative, RESTRICT on the parent side, refuses to delete a coordination until every
-- area under it has been moved by hand, which is the state somebody reorganising is trying
-- to get out of.

CREATE TABLE area_hierarchy (
    child_area_id  bigint PRIMARY KEY REFERENCES areas (id) ON DELETE CASCADE,
    parent_area_id bigint NOT NULL    REFERENCES areas (id) ON DELETE CASCADE,
    -- One hop of the cycle problem, and the only hop a CHECK can see.
    CONSTRAINT area_hierarchy_no_self CHECK (parent_area_id <> child_area_id)
);
COMMENT ON TABLE area_hierarchy IS 'Which area hangs under which. A row per area that has a parent; no row means root. RF-USR-09, RF-USR-04.';

-- The primary key already indexes the child. This is for the other direction, which is the
-- one the chart walks: "give me the children of this area", once per node.
CREATE INDEX idx_area_hierarchy_parent_area_id ON area_hierarchy (parent_area_id);


-- Closes the per-area structure half of DATAMODEL.md 5.2. The other half -- moving
-- users.role_id onto area_members so a role can differ per area -- is still open and still
-- its own branch.


-- Down Migration

DROP TABLE IF EXISTS area_hierarchy;

ALTER TABLE roles DROP COLUMN description;
