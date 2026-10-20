// Request formats (RF-SOL-01). A format's fields are published as versions that never change;
// to edit one, publish a new version. A field key means one thing system-wide, so publishing an
// existing key with a different type is refused.
import query from "../resources/query.js";
import events from "../../utils/events.js";
import { currentActor } from "../../utils/context.js";
import { ApiError } from "../../utils/ApiError.js";
import {
  UNIQUE_VIOLATION,
  FOREIGN_KEY_VIOLATION,
  requireText,
  optionalText,
  requireId,
} from "../../utils/validate.js";

/**
 *  Column widths from projects-spine, checked here so a 22001 becomes a 400 naming the field.
 */
const CODE_MAX = 50;
const NAME_MAX = 300;

/**
 * A field code is the key in `requests.data`, in a column map and in `project_field_values`, so
 * it uses a narrow character set and is unique across both sections.
 */
const FIELD_CODE = /^[a-z][a-z0-9_]{0,99}$/;

/** The two section keys, in the order a form renders them. */
export const SECTIONS = ["deliverables", "information"];

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

      return shapeSchema(row, await baseTypes());
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

      return shapeSchema(row, await baseTypes());
    } catch (err) {
      throw translate(err);
    }
  }

  /** One schema with its latest version. @throws {ApiError} 404. */
  async get(schemaId) {
    const row = await query.getSchema(requireId(schemaId, "schemaId"));
    if (!row) throw ApiError.notFound("Schema not found.");
    return shapeSchema(row, await baseTypes());
  }

  /** Every schema with its latest version, active or not; the client filters. */
  async getAll() {
    const types = await baseTypes();
    return (await query.getSchemas()).map((row) => shapeSchema(row, types));
  }

  /**
   * Every key ever published, with its latest definition and where it is used. Lo que el
   * constructor de formatos ofrece para que una clave se reuse en vez de reinventarse.
   */
  async listFieldKeys() {
    return (await query.listFieldKeys()).map(shapeFieldKey);
  }

  /**
   * Registers a key no format declares, so a stage can ask for or deliver it with a name and a type
   * (DATAMODEL §2.13b, RF-FLW-06). Without `key`, it is made from the name. A key that already
   * exists with the same type is returned as it is; with another type, it is refused.
   *
   * @param {{key?: string, name: string, type: string, note?: string}} input
   * @throws {ApiError} 400 on a bad key, name or type, 409 when the key exists with another type.
   */
  async createFieldKey(input) {
    const body = input ?? {};
    const name = requireText(body.name, "name", 200);
    const key = typeof body.key === "string" && body.key.trim() !== "" ? body.key.trim() : keyFromName(name);
    if (!FIELD_CODE.test(key)) {
      throw ApiError.badRequest("key must be snake_case: a lowercase letter, then letters, digits or _ (100 max).");
    }
    const type = typeof body.type === "string" ? body.type.trim().toLowerCase() : "";
    const dataType = type === "" ? null : await query.getDataType(type);
    if (!dataType || !dataType.is_active) {
      throw ApiError.badRequest(`Data type "${type}" does not exist or is inactive.`);
    }

    const known = (await fieldVocabulary()).get(key);
    if (known !== undefined) {
      if (known.type !== type) {
        throw ApiError.conflict(`"${key}" already exists as "${known.type}" (${known.name}); reuse it or pick another name.`);
      }
      return shapeFieldKey(known);
    }

    const row = await query.insertFieldKey({
      key,
      name,
      type,
      note: optionalText(body.note, "note", 2000),
      createdBy: currentActor().id,
    });
    const created = row ?? (await fieldVocabulary()).get(key);
    await events.emit({ action: "record_created", after: { table: "field_keys", ...created } });
    return shapeFieldKey({ ...created, source: "registered", schema_count: 0, schemas: [] });
  }

  /** Every version of a schema, newest first. @throws {ApiError} 404. */
  async getVersions(schemaId) {
    const id = requireId(schemaId, "schemaId");
    if (!(await query.getSchema(id))) throw ApiError.notFound("Schema not found.");
    const types = await baseTypes();
    return (await query.getSchemaVersions(id)).map((row) => shapeSchemaVersion(row, types));
  }

  /** One version by its id, with the schema it belongs to. @throws {ApiError} 404. */
  async getVersion(versionId) {
    const row = await query.getSchemaVersion(requireId(versionId, "versionId"));
    if (!row) throw ApiError.notFound("Schema version not found.");
    return shapeSchemaVersion(row, await baseTypes());
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

      return shapeSchemaVersion(row, await baseTypes());
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

    return shapeSchema(row, await baseTypes());
  }
}

/** The session's user id, or null outside a request (a script, a job). */
function publisher() {
  return currentActor()?.id ?? null;
}

/**
 * Checks a `fields` document and returns it cleaned up (trimmed strings, `note` and `required`
 * filled in). The shape is `{ deliverables: [...], information: [...] }`, each field
 * `{ code, name, type, note, required }`: deliverables are what the area produces, information
 * what the requester states, and `type` is a `data_types.code`. Sections are arrays, not objects
 * keyed by code, because jsonb reorders object keys and capture order would be lost.
 *
 * @param {{ deliverables: object[], information: object[] }} fields
 * @returns {Promise<{ deliverables: object[], information: object[] }>}
 * @throws {ApiError} 400 naming the field and what is wrong with it.
 */
export async function validateFields(fields, vocabulary = null) {
  const known = vocabulary ?? (await fieldVocabulary());
  if (Array.isArray(fields)) {
    throw ApiError.badRequest(
      'Fields must be an object with "deliverables" and "information" arrays, not a flat array.',
    );
  }
  if (!fields || typeof fields !== "object") {
    throw ApiError.badRequest(
      'Fields must be an object with "deliverables" and "information" arrays.',
    );
  }

  for (const key of Object.keys(fields)) {
    if (!SECTIONS.includes(key)) {
      throw ApiError.badRequest(
        `Unknown section "${key}": fields may only hold "deliverables" and "information".`,
      );
    }
  }

  for (const section of SECTIONS) {
    if (!Array.isArray(fields[section])) {
      throw ApiError.badRequest(`Section "${section}" is required and must be an array.`);
    }
  }

  if (SECTIONS.every((section) => fields[section].length === 0)) {
    throw ApiError.badRequest("A format must define at least one field.");
  }

  const seen = new Set();
  const out = { deliverables: [], information: [] };

  for (const section of SECTIONS) {
    for (const field of fields[section]) {
      out[section].push(await validateField(field, section, seen, known));
    }
  }

  return out;
}

/** `code` -> its published definition, for the consistency check above. */
/** One entry of the vocabulary as the API returns it. */
function shapeFieldKey(row) {
  return {
    key: row.key,
    name: row.name,
    type: row.type,
    note: row.note ?? "",
    source: row.source ?? "format",
    schemaCount: row.schema_count ?? 0,
    schemas: row.schemas ?? [],
  };
}

/** A key made from a person's name for it: "Costo total" → `costo_total`, accents dropped. */
function keyFromName(name) {
  const key = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
  return /^[a-z]/.test(key) ? key : `dato_${key}`.slice(0, 100);
}

async function fieldVocabulary() {
  const rows = await query.listFieldKeys();
  return new Map(rows.map((row) => [row.key, row]));
}

/** One field of one section. @throws {ApiError} 400. */
async function validateField(field, section, seen, known) {
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw ApiError.badRequest(`Each field of "${section}" must be an object.`);
  }

  const code = typeof field.code === "string" ? field.code.trim() : "";
  if (!code) throw ApiError.badRequest(`Each field of "${section}" must have a code.`);
  if (!FIELD_CODE.test(code)) {
    throw ApiError.badRequest(
      `Field "${code}" code must be snake_case: a lowercase letter, then letters, digits or _ (100 max).`,
    );
  }
  if (seen.has(code)) {
    throw ApiError.badRequest(`Field "${code}" is repeated; codes are unique across both sections.`);
  }
  seen.add(code);

  const name = typeof field.name === "string" ? field.name.trim() : "";
  if (!name) throw ApiError.badRequest(`Field "${code}" must have a name.`);

  const type = typeof field.type === "string" ? field.type.trim().toLowerCase() : "";
  if (!type) throw ApiError.badRequest(`Field "${code}" must have a type.`);

  if (field.required !== undefined && typeof field.required !== "boolean") {
    throw ApiError.badRequest(`Field "${code}" required must be a boolean.`);
  }

  if (field.note !== undefined && field.note !== null && typeof field.note !== "string") {
    throw ApiError.badRequest(`Field "${code}" note must be a string.`);
  }

  const dataType = await query.getDataType(type);
  if (!dataType || !dataType.is_active) {
    throw ApiError.badRequest(`Data type "${type}" does not exist or is inactive.`);
  }

  const published = known.get(code);
  if (published !== undefined && published.type !== type) {
    const where = (published.schemas ?? []).join(", ");
    throw ApiError.badRequest(
      `Field "${code}" already exists as "${published.type}"` +
        `${where === "" ? "" : ` in ${where}`}, so it cannot be published as "${type}". ` +
        "Reuse it with that type, or pick another key.",
    );
  }

  return {
    code,
    name,
    type,
    note: (field.note ?? "").trim(),
    required: field.required ?? false,
  };
}

/**
 * Both sections as one list, each field carrying the `section` it came from. What the
 * validators, the column map and the convert step want: they care about the codes, not
 * about how a form groups them.
 *
 * @param {{ deliverables: object[], information: object[] }} fields
 * @returns {object[]}
 */
export function fieldList(fields) {
  return SECTIONS.flatMap((section) =>
    (fields?.[section] ?? []).map((field) => ({ ...field, section })),
  );
}

/**
 * `data_types.code` -> `base_type`, read once per response rather than per field. A client
 * that only cares about string-vs-number reads `baseType` and never learns the catalogue.
 */
async function baseTypes() {
  const rows = await query.getDataTypes();
  return new Map(rows.map((row) => [row.code, row.base_type]));
}

/** The stored document with `baseType` attached to every field. */
function withBaseTypes(fields, types) {
  if (!fields) return fields ?? null;
  const decorate = (list) =>
    (list ?? []).map((field) => ({ ...field, baseType: types.get(field.type) ?? null }));
  return { deliverables: decorate(fields.deliverables), information: decorate(fields.information) };
}

/** snake_case row in, camelCase JSON out. The version keys are null on a schema with none. */
function shapeSchema(row, types) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    createdAt: row.created_at,
    version: row.version ?? null,
    fields: row.fields ? withBaseTypes(row.fields, types) : null,
    publishedAt: row.published_at ?? null,
    publishedBy: row.published_by ?? null,
    publishedByName: row.published_by_name ?? null,
    schemaVersionId: row.schema_version_id ?? null,
    requestCount: row.request_count ?? 0,
    sheetCount: row.sheet_count ?? 0,
  };
}

export function shapeSchemaVersion(row, types) {
  return {
    id: row.id,
    schemaId: row.schema_id,
    version: row.version,
    fields: withBaseTypes(row.fields, types),
    publishedAt: row.published_at,
    publishedBy: row.published_by,
    schemaCode: row.schema_code ?? undefined,
    schemaName: row.schema_name ?? undefined,
    schemaIsActive: row.schema_is_active ?? undefined,
  };
}

/** A constraint violation into the matching 4xx error; anything else untouched. */
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
