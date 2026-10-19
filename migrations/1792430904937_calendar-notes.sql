-- Notas del calendario: un recordatorio corto pegado a un día, como un post-it. Es un evento más,
-- de tipo `nota`. Quién la ve sale de sus participantes, como todo en el calendario, con una
-- diferencia: la nota personal tiene como participante a su autor y la ve solo él, aunque sea
-- de un compañero de área o quien consulta sea coordinación (DATAMODEL §2.19).

-- Up Migration

INSERT INTO event_types (code, label) VALUES ('nota', 'Nota')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

CREATE TEMP TABLE note_events AS
SELECT e.id FROM events e JOIN event_types et ON et.id = e.event_type_id WHERE et.code = 'nota';
DELETE FROM event_participants WHERE event_id IN (SELECT id FROM note_events);
DELETE FROM event_exceptions WHERE event_id IN (SELECT id FROM note_events);
DELETE FROM collection_events WHERE event_id IN (SELECT id FROM note_events);
DELETE FROM events WHERE id IN (SELECT id FROM note_events);
DROP TABLE note_events;
DELETE FROM event_types WHERE code = 'nota';
