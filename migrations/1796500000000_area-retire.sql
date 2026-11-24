-- Up Migration

-- An area with history cannot be deleted: stages, requests and the audit trail name it. Deleting one
-- that nobody uses any more retires it, as with contract types, and it only leaves the pickers.
ALTER TABLE areas ADD COLUMN is_active boolean NOT NULL DEFAULT true;

-- A retired area takes no new members, stages, requests, statuses, sub-areas or people. One trigger,
-- since each of those has several write paths; the argument is the column that names the area.
CREATE FUNCTION refuse_retired_area() RETURNS trigger AS $$
DECLARE
    area bigint := (to_jsonb(NEW) ->> TG_ARGV[0])::bigint;
BEGIN
    IF area IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF area IS NOT DISTINCT FROM (to_jsonb(OLD) ->> TG_ARGV[0])::bigint THEN
            RETURN NEW;
        END IF;
    END IF;
    IF EXISTS (SELECT 1 FROM areas WHERE id = area AND NOT is_active) THEN
        RAISE EXCEPTION 'That area is retired.'
            USING ERRCODE = 'check_violation', CONSTRAINT = 'area_retired';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER area_members_refuse_retired BEFORE INSERT OR UPDATE ON area_members
    FOR EACH ROW EXECUTE FUNCTION refuse_retired_area('area_id');
CREATE TRIGGER flow_stages_refuse_retired BEFORE INSERT OR UPDATE ON flow_stages
    FOR EACH ROW EXECUTE FUNCTION refuse_retired_area('area_id');
CREATE TRIGGER requests_refuse_retired BEFORE INSERT OR UPDATE ON requests
    FOR EACH ROW EXECUTE FUNCTION refuse_retired_area('area_id');
CREATE TRIGGER statuses_refuse_retired BEFORE INSERT OR UPDATE ON statuses
    FOR EACH ROW EXECUTE FUNCTION refuse_retired_area('area_id');
CREATE TRIGGER users_refuse_retired BEFORE INSERT OR UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION refuse_retired_area('primary_area_id');
CREATE TRIGGER area_hierarchy_refuse_retired BEFORE INSERT OR UPDATE ON area_hierarchy
    FOR EACH ROW EXECUTE FUNCTION refuse_retired_area('parent_area_id');

-- Down Migration

DROP TRIGGER area_hierarchy_refuse_retired ON area_hierarchy;
DROP TRIGGER users_refuse_retired ON users;
DROP TRIGGER statuses_refuse_retired ON statuses;
DROP TRIGGER requests_refuse_retired ON requests;
DROP TRIGGER flow_stages_refuse_retired ON flow_stages;
DROP TRIGGER area_members_refuse_retired ON area_members;
DROP FUNCTION refuse_retired_area();
ALTER TABLE areas DROP COLUMN is_active;
