import express from 'express';
import {
  getSpreadsheetTables,
  getSpreadsheetRows,
} from '../access/resources/spreadsheets.js';

const router = express.Router();

/**
 * Ruta de prueba para obtener las tablas de un Excel.
 *
 * Por ahora recibe el token, driveId e itemId
 * mediante headers/query para poder probar la estructura.
 *
 * La autenticación de Microsoft se conectará posteriormente.
 */

//RECIBE LA PETICIÓN HTTP
router.get('/tables', async (req, res, next) => {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    const { driveId, itemId } = req.query;

    if (!accessToken) {
      return res.status(401).json({
        error: 'Access token is required.',
      });
    }

    if (!driveId || !itemId) {
      return res.status(400).json({
        error: 'driveId and itemId are required.',
      });
    }

    const data = await getSpreadsheetTables({
      accessToken,
      driveId,
      itemId,
    });

    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * Ruta de prueba para obtener las filas de una tabla de Excel.
 */
router.get('/rows', async (req, res, next) => {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    const {
      driveId,
      itemId,
      tableName,
    } = req.query;

    if (!accessToken) {
      return res.status(401).json({
        error: 'Access token is required.',
      });
    }

    if (!driveId || !itemId || !tableName) {
      return res.status(400).json({
        error: 'driveId, itemId and tableName are required.',
      });
    }

    const data = await getSpreadsheetRows({
      accessToken,
      driveId,
      itemId,
      tableName,
    });

    res.json(data);
  } catch (error) {
    next(error);
  }
});

//PRUEBA DE CONEXIÓN
router.get('/test', async (req, res, next) => {
  try {
    const accessToken = process.env.GRAPH_TEST_TOKEN;

    if (!accessToken) {
      return res.status(500).json({
        error: 'GRAPH_TEST_TOKEN is not configured.',
      });
    }

    res.json({
      message: 'Spreadsheet integration route is working.',
      tokenConfigured: true,
    });
  } catch (error) {
    next(error);
  }
}); //FUNCIONA

//test graph TEMPORAL
router.get('/test-graph', async (req, res, next) => {
  try {
    const accessToken = process.env.GRAPH_TEST_TOKEN;

    const { driveId, itemId } = req.query;

    if (!accessToken) {
      return res.status(500).json({
        error: 'GRAPH_TEST_TOKEN is not configured.',
      });
    }

    if (!driveId || !itemId) {
      return res.status(400).json({
        error: 'driveId and itemId are required.',
      });
    }

    const data = await getSpreadsheetTables({
      accessToken,
      driveId,
      itemId,
    });

    res.json(data);
  } catch (error) {
    next(error);
  }
}); //FUNCIONA


export default router;