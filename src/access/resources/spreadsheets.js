/* RECURSO PARA MICROSOFT EXCEL */

import {
    getWorkbookTables,
    getTableRows
} from "../primitives/microsoftExcel.js";

/**
 * Obtiene las tablas de un archivo Excel.
 *
 * Este recurso utiliza el primitivo de Microsoft Excel
 * para comunicarse con Microsoft Graph.
 *
 * @param {Object} options
 * @param {string} options.accessToken - Token de acceso de Microsoft.
 * @param {string} options.driveId - Identificador del drive.
 * @param {string} options.itemId - Identificador del archivo Excel.
 * @returns {Promise<Object>}
 */
export async function getSpreadsheetTables({
    accessToken,
    driveId,
    itemId
}) {
    return await getWorkbookTables({
        accessToken,
        driveId,
        itemId
    });
}

/**
 * Obtiene las filas de una tabla de Excel.
 *
 * @param {Object} options
 * @param {string} options.accessToken - Token de acceso de Microsoft.
 * @param {string} options.driveId - Identificador del drive.
 * @param {string} options.itemId - Identificador del archivo Excel.
 * @param {string} options.tableName - Nombre de la tabla.
 * @returns {Promise<Object>}
 */
export async function getSpreadsheetRows({
    accessToken,
    driveId,
    itemId,
    tableName
}) {
    return await getTableRows({
        accessToken,
        driveId,
        itemId,
        tableName
    });
}