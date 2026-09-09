/* PRIMITIVO PARA MICROSOFT EXCEL ACCESS

Este módulo contiene la conexión lógica con
Microsoft Graph y Excel.
*/

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

/**
 * Obtiene las tablas de un archivo Excel.
 *
 * @param {Object} options
 * @param {string} options.accessToken - Token de acceso de Microsoft.
 * @param {string} options.driveId - Identificador del drive.
 * @param {string} options.itemId - Identificador del archivo Excel.
 * @returns {Promise<Object>}
 */

export async function getWorkbookTables({
    accessToken,
    driveId,
    itemId
}) {
    const url =
        `${GRAPH_BASE_URL}/drives/${driveId}/items/${itemId}/workbook/tables`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        throw new Error(
            `Microsoft Graph error: ${response.status} ${response.statusText}`
        );
    }

    return await response.json();
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
export async function getTableRows({
    accessToken,
    driveId,
    itemId,
    tableName
}) {
    const url =
        `${GRAPH_BASE_URL}/drives/${driveId}/items/${itemId}/workbook/tables/${tableName}/rows`;

    const response = await fetch(url, {
        method: "GET",
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });

    if (!response.ok) {
        throw new Error(
            `Microsoft Graph error: ${response.status} ${response.statusText}`
        );
    }

    return await response.json();
}