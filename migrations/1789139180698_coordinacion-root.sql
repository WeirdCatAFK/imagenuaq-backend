-- Up Migration

-- The organisation chart had no root.
--
-- `roles-and-areas` gave the organisation a shape (`area_hierarchy`), but the seven areas
-- `catalog-bootstrap` seeded were all left as roots, so the chart RF-USR-09 implies drew
-- seven unrelated boxes. That migration's section 4 read the interviews as using
-- "Coordinación" and "Secretaría Particular" interchangeably and made it one of the seven
-- rather than a container above them. This revises that reading in one respect: the
-- interviews also make coordination the level that consults the work of "todos los usuarios
-- a su cargo" (RF-USR-04), which in the hierarchy is the subtree under the coordination --
-- and a subtree needs the coordination to be a node above the areas, not beside them.
--
-- Two statements. The seeded row is RENAMED, not duplicated: adding a new "Coordinación"
-- next to "Secretaría Particular" would leave two rows for what the interviews treat as one
-- office, and nothing to say which of them people should be assigned to. Then every area
-- that currently has no parent is hung under it -- every current root, not the six seeded
-- names, so an area created through the API before this ran ends up in the tree as well.
-- Both are guarded so re-running is harmless: the rename is skipped if a "Coordinación"
-- already exists, and the hierarchy insert skips areas that already have a parent.
--
-- Where new areas go from here on is not a schema question. `Areas.create()` in
-- access/orchestration/areas.js hangs an area whose request names no parent under the area
-- DEFAULT_AREA names in .env, and scripts/createAdmin.js puts an admin without --area in
-- the same one. The name lives in .env rather than here because it is a deployment's
-- choice, and because coordination may rename the area at any time (RF-USR-09).

UPDATE areas
   SET name = 'Coordinación'
 WHERE name = 'Secretaría Particular'
   AND NOT EXISTS (SELECT 1 FROM areas WHERE name = 'Coordinación');

INSERT INTO area_hierarchy (child_area_id, parent_area_id)
SELECT a.id, c.id
  FROM areas a
  JOIN areas c ON c.name = 'Coordinación'
 WHERE a.id <> c.id
   AND NOT EXISTS (SELECT 1 FROM area_hierarchy h WHERE h.child_area_id = a.id);


-- Down Migration

-- Only the links the Up is answerable for: the six remaining seeded areas, by name. An area
-- created later and hung under Coordinación by hand keeps its parent -- the Down cannot
-- tell that row from one somebody placed deliberately, and removing it would silently
-- flatten part of the chart. The rename is reversed second, so that catalog-bootstrap's
-- Down, which deletes by the old name, still finds the row.

DELETE FROM area_hierarchy h
 USING areas a, areas c
 WHERE h.child_area_id = a.id
   AND h.parent_area_id = c.id
   AND c.name = 'Coordinación'
   AND a.name IN ('Producción Audiovisual', 'Diseño Gráfico', 'Diseño Web',
                  'Administración', 'Imprenta', 'Impresión');

UPDATE areas
   SET name = 'Secretaría Particular'
 WHERE name = 'Coordinación'
   AND NOT EXISTS (SELECT 1 FROM areas WHERE name = 'Secretaría Particular');
