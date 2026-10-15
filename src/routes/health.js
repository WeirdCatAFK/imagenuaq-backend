import { Router } from 'express';
import health from '../access/orchestration/health.js';

const router = Router();

router.get('/', async (_req, res) => {
  const report = await health.check();
  res.status(report.status === 'ok' ? 200 : 503).json(report);
});

export default router;
