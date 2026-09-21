// Tier 3: request formats (RF-SOL-01), the "schemas" of DATAMODEL.md 2.2 and 2.3.
//
// A schema is a stable identity (code, name, active flag); what it asks for lives in
// `schema_versions.fields`, an ordered array that is immutable once published -- the
// trigger in projects-spine rejects the UPDATE, so "editing" a format is publishing the
// next version. Requests, projects and sheets point at a version, never at the schema, so
// what was captured under v1 still reads as v1 after v2 exists.
//
// A field is `{ code, name, type, section, required, propagate, options }`:
//   code      snake_case, unique in the version. It is the key in `requests.data`, the
//             target a sheet's column map names, and the `project_field_values.key` the
//             value lands under when it propagates -- hence the same character set.
//   type      a `data_types.code`; the coercion a value goes through is chosen by it.
//   section   `deliverables` (something to produce) or `information` (something to know).
//   required  the request is refused without it.
//   propagate the value leaves the request and becomes a `project_field_values` row when
//             the request is converted (RF-FLW-06, RF-IMP-05). Independent of `section`.
//   options   free object for the type's extras (a select's choices, a hint). Not validated
//             beyond being an object; the builder owns its meaning.
//
// Templates (RF-SOL-01, "conforme crecen las coordinaciones") are clones: `clone()` copies
// the latest version's fields into a new identity's version 1. A field-group catalogue
// that schemas compose was considered and declined -- it adds a table and a propagation
// rule for a reuse the copy already gives, and the formats the interviews name share a
// handful of fields, not blocks.
//
// The publisher is the session's actor, never a body field: `published_by` is an audit
// fact and a client may not attribute a publish to someone else.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

/** Column widths from projects-spine, checked here so a 22001 becomes a 400 naming the field. */
const CODE_MAX = 50;
const NAME_MAX = 300;

/** Field codes are keys elsewhere (see header), so the character set is the narrow one. */
const FIELD_CODE = /^[a-z][a-z0-9_]{0,99}$/;
const SECTIONS = new Set(["deliverables", "information"]);

class Schemas {
  /**
   * Creates a schema and publishes its version 1 in one statement.
   *
   * @param {{ code: string, name: string, fields: object[] }} input
   * @returns {Promise<object>} The schema with its version.
   * @throws {ApiError} 400 on a bad payload or field, 409 when the code is taken.
   */
  async create({ code, name, fields }) {
    const cleanCode = requireText(code, "code", CODE_MAX);
    const cleanName = requireText(name, "name", NAME_MAX);
    const normalised = await validateFields(fields);

    try {
      const row = await query.createSchema({
        code: cleanCode,
        name: cleanName,
        fields: normalised,
        publishedBy: publisher(),
      });

      await events.emit({
        action: "record_created",
        target: { table: "schemas", id: row.id },
        after: row,
      });

      return shapeSchema(row);
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * A new identity whose version 1 carries the source's latest fields (RF-SOL-01 templates).
   *
   * @throws {ApiError} 404 when the source does not exist, 409 when the code is taken.
   */
  async clone(sourceId, { code, name }) {
    const id = requireId(sourceId, "schemaId");
    const cleanCode = requireText(code, "code", CODE_MAX);
    const cleanName = requireText(name, "name", NAME_MAX);

    try {
      const row = await query.cloneSchema(id, {
        code: cleanCode,
        name: cleanName,
        publishedBy: publisher(),
      });
      if (!row) throw ApiError.notFound("Schema not found.");

      await events.emit({
        action: "record_created",
        target: { table: "schemas", id: row.id },
        after: { ...row, cloned_from: id },
      });

      return shapeSchema(row);
    } catch (err) {
      throw translate(err);
    }
  }

  /** One schema with its latest version. @throws {ApiError} 404. */
  async get(schemaId) {
    const row = await query.getSchema(requireId(schemaId, "schemaId"));
    if (!row) throw ApiError.notFound("Schema not found.");
    return shapeSchema(row);
  }

  /** Every schema with its latest version, active or not; the client filters. */
  async getAll() {
    return (await query.getSchemas()).map(shapeSchema);
  }

  /** Every version of a schema, newest first. @throws {ApiError} 404. */
  async getVersions(schemaId) {
    const id = requireId(schemaId, "schemaId");
    if (!(await query.getSchema(id))) throw ApiError.notFound("Schema not found.");
    return (await query.getSchemaVersions(id)).map(shapeSchemaVersion);
  }

  /** One version by its id, with the schema it belongs to. @throws {ApiError} 404. */
  async getVersion(versionId) {
    const row = await query.getSchemaVersion(requireId(versionId, "versionId"));
    if (!row) throw ApiError.notFound("Schema version not found.");
    return shapeSchemaVersion(row);
  }

  /**
   * Publishes the next version. The previous ones are never modified.
   *
   * @throws {ApiError} 404 when the schema does not exist, 409 when it is inactive.
   */
  async createVersion(schemaId, { fields }) {
    const id = requireId(schemaId, "schemaId");
    const normalised = await validateFields(fields);

    const schema = await query.getSchema(id);
    if (!schema) throw ApiError.notFound("Schema not found.");
    if (schema.is_active === false) {
      throw ApiError.conflict("Cannot create a version for an inactive schema.");
    }

    try {
      const row = await query.createSchemaVersion(id, {
        fields: normalised,
        publishedBy: publisher(),
      });

      await events.emit({
        action: "record_created",
        target: { table: "schema_versions", id: row.id },
        after: row,
      });

      return shapeSchemaVersion(row);
    } catch (err) {
      throw translate(err);
    }
  }

  /**
   * Identity-level edit: rename, or flip the active flag either way. Versions are not
   * reachable from here by design.
   *
   * @throws {ApiError} 400 when nothing valid is sent, 404.
   */
  async update(schemaId, { name, isActive }) {
    const id = requireId(schemaId, "schemaId");
    const cleanName = name === undefined ? undefined : requireText(name, "name", NAME_MAX);
    if (isActive !== undefined && typeof isActive !== "boolean") {
      throw ApiError.badRequest("isActive must be a boolean.");
    }
    if (cleanName === undefined && isActive === undefined) {
      throw ApiError.badRequest("Nothing to update: send name or isActive.");
    }

    const before = await query.getSchema(id);
    if (!before) throw ApiError.notFound("Schema not found.");

    const row = await query.updateSchema(id, { name: cleanName, isActive });

    await events.emit({
      action: "record_updated",
      target: { table: "schemas", id: row.id },
      before,
      after: row,
    });

    return this.get(id);
  }

  /**
   * Deactivates a schema. The row and its versions stay: requests captured under them
   * still need to read.
   *
   * @throws {ApiError} 404, 409 when already inactive.
   */
  async delete(schemaId) {
    const id = requireId(schemaId, "schemaId");

    const before = await query.getSchema(id);
    if (!before) throw ApiError.notFound("Schema not found.");
    if (before.is_active === false) throw ApiError.conflict("Schema is already inactive.");

    const row = await query.desactivateSchema(id);

    await events.emit({
      action: "record_deleted",
      target: { table: "schemas", id: row.id },
      before,
      after: row,
    });

    return shapeSchema(row);
  }
}

/* HELPERS */

/** The session's user id, or null outside a request (a script, a job). */
function publisher() {
  return currentActor()?.id ?? null;
}

function requireText(value, field, max) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw ApiError.badRequest(`${field} is required.`);
  if (text.length > max) throw ApiError.badRequest(`${field} must be ${max} characters or fewer.`);
  return text;
}

function requireId(value, field) {
  if (value === null || value === undefined || typeof value === "boolean") {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }
  return id;
}

/**
 * Checks a field array against the shape in the header and returns it normalised --
 * trimmed strings, defaults filled -- so what is stored is canonical whatever the client
 * sent. Exported for the modules that validate a field list they did not receive from a
 * client (a clone, a seed check).
 *
 * @throws {ApiError} 400 naming the field and what is wrong with it.
 */
export async function validateFields(fields) {
  if (!Array.isArray(fields)) throw ApiError.badRequest("Fields must be an array.");
  if (fields.length === 0) throw ApiError.badRequest("Fields must not be empty.");

  const seen = new Set();
  const out = [];

  for (const field of fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw ApiError.badRequest("Each field must be an object.");
    }

    const code = typeof field.code === "string" ? field.code.trim() : "";
    if (!code) throw ApiError.badRequest("Each field must have a code.");
    if (!FIELD_CODE.test(code)) {
      throw ApiError.badRequest(
        `Field "${code}" code must be snake_case: a lowercase letter, then letters, digits or _ (100 max).`,
      );
    }
    if (seen.has(code)) throw ApiError.badRequest(`Field "${code}" is repeated.`);
    seen.add(code);

    const name = typeof field.name === "string" ? field.name.trim() : "";
    if (!name) throw ApiError.badRequest(`Field "${code}" must have a name.`);

    const type = typeof field.type === "string" ? field.type.trim().toLowerCase() : "";
    if (!type) throw ApiError.badRequest(`Field "${code}" must have a type.`);

    if (!SECTIONS.has(field.section)) {
      throw ApiError.badRequest(
        `Field "${code}" section must be "deliverables" or "information".`,
      );
    }

    for (const flag of ["required", "propagate"]) {
      if (field[flag] !== undefined && typeof field[flag] !== "boolean") {
        throw ApiError.badRequest(`Field "${code}" ${flag} must be a boolean.`);
      }
    }

    if (
      field.options !== undefined &&
      (field.options === null || typeof field.options !== "object" || Array.isArray(field.options))
    ) {
      throw ApiError.badRequest(`Field "${code}" options must be an object.`);
    }

    const dataType = await query.getDataType(type);
    if (!dataType || !dataType.is_active) {
      throw ApiError.badRequest(`Data type "${type}" does not exist or is inactive.`);
    }

    out.push({
      code,
      name,
      type,
      section: field.section,
      required: field.required ?? false,
      propagate: field.propagate ?? false,
      options: field.options ?? {},
    });
  }

  return out;
}

/** snake_case row in, camelCase JSON out. The version keys are null on a schema with none. */
function shapeSchema(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    createdAt: row.created_at,
    version: row.version ?? null,
    fields: row.fields ?? null,
    publishedAt: row.published_at ?? null,
    publishedBy: row.published_by ?? null,
    schemaVersionId: row.schema_version_id ?? null,
  };
}

export function shapeSchemaVersion(row) {
  return {
    id: row.id,
    schemaId: row.schema_id,
    version: row.version,
    fields: row.fields,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    schemaCode: row.schema_code ?? undefined,
    schemaName: row.schema_name ?? undefined,
    schemaIsActive: row.schema_is_active ?? undefined,
  };
}

/** A constraint violation into the refusal the caller earned; anything else untouched. */
function translate(err) {
  if (err?.code === UNIQUE_VIOLATION) {
    return ApiError.conflict("A schema with that code already exists.");
  }
  if (err?.code === FOREIGN_KEY_VIOLATION) {
    return ApiError.badRequest("The referenced record does not exist.");
  }
  return err;
}

export default new Schemas();
