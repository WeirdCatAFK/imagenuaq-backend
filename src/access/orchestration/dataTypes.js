// Lists the field data types. Read-only: a new type is added by migration, together with its
// conversion rule in utils/fieldValues.js.
import query from "../resources/query.js";
import { ApiError } from "../../utils/ApiError.js";
import { cleanText } from "../../utils/validate.js";

class DataTypes {
  /**
   * @param {string} code
   * @returns {Promise<object>}
   * @throws {ApiError} 400 when blank, 404 when unknown.
   */
  async get(code) {
    const cleanCode = cleanText(code)?.toLowerCase() ?? null;
    if (!cleanCode) throw ApiError.badRequest("Data type code is required.");

    const dataType = await query.getDataType(cleanCode);
    if (!dataType) throw ApiError.notFound("Data type not found.");

    return shapeDataType(dataType);
  }

  /** @returns {Promise<object[]>} */
  async getAll() {
    return (await query.getDataTypes()).map(shapeDataType);
  }
}

function shapeDataType(row) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    baseType: row.base_type,
    properties: row.properties ?? {},
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export default new DataTypes();
