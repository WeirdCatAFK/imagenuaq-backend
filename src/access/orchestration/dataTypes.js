//Esta capa será la que controle qué puede hacer el sistema con los tipos, mientras query.js se queda únicamente con PostgreSQL.
import query from "../resources/query.js";
import { ApiError } from "../../utils/ApiError.js";

class DataTypes {
    async get(code) {
        const cleanCode = cleanCodeValue(code);

        if (!cleanCode) {
            throw ApiError.badRequest("Data type code is required.");
        }

        const dataType = await query.getDataType(cleanCode);

        if (!dataType) {
            throw ApiError.notFound("Data type not found.");
        }

        return shapeDataType(dataType);
    }

    async getAll() {
        const dataTypes = await query.getDataTypes();

        return dataTypes.map(shapeDataType);
    }
}

function cleanCodeValue(value){
    if (typeof value !== "string") {
        return null;
    }

    const trimmed = value.trim().toLowerCase();

    return trimmed === "" ? null : trimmed;
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