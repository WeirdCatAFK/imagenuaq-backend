-- System folder for absence approval documents ("oficios").
-- Uses admin (id 1) as owner. The folder has no parent (root).
INSERT INTO folders (parent_id, name, owner_id)
SELECT null, 'Oficios de ausencia', 1
 WHERE NOT EXISTS (SELECT 1 FROM folders WHERE name = 'Oficios de ausencia' AND parent_id IS NULL);
