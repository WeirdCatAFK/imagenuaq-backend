import query from "../resources/query.js";
import { ApiError } from "../../utils/ApiError.js";

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

class Schemas{
  //--- CRUD ---
  /**
   * CREATE
   * El schema representa la identidad estable:
   * -code
   * -name
   * -isActive
   * 
   * La primera versión se crea posteriormente con createVersion()
  */
    
  async create({code, name, fields, publishedBy = null,}){
    const cleanCode = cleanText(code);
    const cleanName = cleanText(name);

    if (!cleanCode) {
      throw ApiError.badRequest("Schema code is required.",);
    }

    if (!cleanName) {
      throw ApiError.badRequest("Schema name is required.",);
    }

    await validateFields(fields);

    const publisherId = publishedBy === null || publishedBy === undefined ? null : requireId(publishedBy, "publishedBy");

    try {
      const schema = await query.createSchema({
        code: cleanCode,
        name: cleanName, fields,
        publishedBy: publisherId,
      });
      return shapeSchema(schema);
    } 
    catch (err){
      throw translate(err);
    }
  }

  /**
   * READ
   * 
   * Obtiene un schema por su ID o todos los schemas 
   * 
   * La consulta también devuelve la última versión del schema*
  */

  async get(schemaId){
    const id = requireId(schemaId, "schemaId");
    const schema = await query.getSchema(id);

    if(!schema){
      throw ApiError.notFound("Schema not found.");
    }
    return shapeSchema(schema);
  }

  async getAll(){
    const schemas = await query.getSchemas();
    return schemas.map(shapeSchema);
  }

  /**
   * UPDATE/CREATE VERSION
   * 
   * Crea una nueva versión de un schema existente. 
   * 
   * Las versiones anteriores NO se modifican.
   * Se genera una nueva versión con los nuevos fields.
  */

  async createVersion(schemaId, {fields, publishedBy = null},){
    const id = requireId(schemaId, "schemaId");
    await validateFields(fields);

    const publisherId = publishedBy === null || publishedBy === undefined ? null : requireId(publishedBy, "publishedBy");
    
    try{
      const schema = await query.getSchema(id); //verifica q el schema exista

      if(!schema){
        throw ApiError.notFound("Schema not found.");
      }

      //Si el schema está desactivado, no permitimos crear nuevas versiones
      if(schema.is_active === false){
        throw ApiError.conflict("Cannot create a version for a inactive schema.");
      }
          
      const version = await query.createSchemaVersion(id, {fields, publishedBy: publisherId,});

      return shapeSchemaVersion(version);
    }
    catch (err){
      throw translate(err);
    }
  }
  
  /**
   * DELETE
   * 
   * Desactiva un schema.
   * NO elimina exactamente el registro de la bd.
  */

  async delete(schemaId){
    const id = requireId(schemaId, "schemaId");

    try{
      const schema = await query.getSchema(id);

      if(!schema){
        throw ApiError.notFound("Schema not found.");
      }

      if(schema.is_active === false){
        throw ApiError.conflict("Schema is already inactive.");
      }

      const desactivated = await query.desactivateSchema(id);

      if(!desactivated){
        throw ApiError.notFound("Schema not found.");
      }
        
      return shapeSchema(desactivated);
    }
    catch(err){
      throw translate(err);
    }
  }
}

/* HELPERS */

function cleanText(value) {
  if (typeof value !== "string") {
    return value == null ? null : value;
  }

  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}


//Valuda IDs que deben ser enteros positivos.
function requireId(value, field) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean"
  ) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }

  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) {
    throw ApiError.badRequest(`${field} must be a positive integer.`);
  }

  return id;
}

/**
 * Valida la definición JSON de los fields
 * 
 * Por ahora solo verifica que exista y q sea un objeto JSON valido.
*/

async function validateFields(fields) {
  if (!Array.isArray(fields)) {
    throw ApiError.badRequest(
      "Fields must be an array.",
    );
  }

  for (const field of fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw ApiError.badRequest(
        "Each field must be an object.",
      );
    }

    if (
      typeof field.code !== "string" ||
      field.code.trim() === ""
    ) {
      throw ApiError.badRequest(
        "Each field must have a code.",
      );
    }

    const code = field.code.trim();

    if (
      typeof field.name !== "string" ||
      field.name.trim() === ""
    ) {
      throw ApiError.badRequest(
        `Field "${code}" must have a name.`,
      );
    }

    if (
      typeof field.type !== "string" ||
      field.type.trim() === ""
    ) {
      throw ApiError.badRequest(
        `Field "${code}" must have a type.`,
      );
    }

    if (
      field.section !== "deliverables" &&
      field.section !== "information"
    ) {
      throw ApiError.badRequest(
        `Field "${code}" section must be "deliverables" or "information".`,
      );
    }

    if (
      field.required !== undefined &&
      typeof field.required !== "boolean"
    ) {
      throw ApiError.badRequest(
        `Field "${code}" required must be a boolean.`,
      );
    }

    const dataTypeCode = field.type.trim().toLowerCase();

    const dataType = await query.getDataType(dataTypeCode);

    if (!dataType || !dataType.is_active) {
      throw ApiError.badRequest(
        `Data type "${dataTypeCode}" does not exist or is inactive.`,
      );
    }
  }
}

//Convierte la fila de Postgrecito al formato de la API
function shapeSchema(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.is_active,
    createdAt: row.created_at,

    // Si la consulta trae una versión, la incluimos.
    version: row.version ?? null,
    fields: row.fields ?? null,
    publishedAt: row.published_at ?? null,
    publishedBy: row.published_by ?? null,
    schemaVersionId: row.schema_version_id ?? null,
  };
}

//Convierte una versión de Postgrecito al formato de la APIO

function shapeSchemaVersion(row) {
  return {
    id: row.id,
    schemaId: row.schema_id,
    version: row.version,
    fields: row.fields,
    publishedAt: row.published_at,
    publishedBy: row.published_by,
  };
}

//Traduce errores conocidos de postgrecito a errores HTTP
function translate(err) {
    if (err?.code === UNIQUE_VIOLATION) {
    return ApiError.conflict(
      "A schema with that code already exists.",
    );
    }
    
    if(err?.code === FOREIGN_KEY_VIOLATION){
        return ApiError.badRequest("The referenced record does not exist.",);
    }

  return err;
}

export default new Schemas();