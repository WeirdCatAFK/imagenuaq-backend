-- System folder for absence approval documents ("oficios").
-- Uses the first user as owner. Skips safely when no users exist (test database).
INSERT INTO folders (parent_id, name, owner_id)
SELECT null, 'Oficios de ausencia', (SELECT id FROM users ORDER BY id LIMIT 1)
 WHERE EXISTS (SELECT 1 FROM users)
   AND NOT EXISTS (SELECT 1 FROM folders WHERE name = 'Oficios de ausencia' AND parent_id IS NULL);
