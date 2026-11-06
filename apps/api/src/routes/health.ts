import { Router } from 'express';

import { prisma } from '../database/prisma.js';
import { logger } from '../utils/logger.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
  });
});

healthRouter.get('/health/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({ status: 'ok', database: 'connected' });
  } catch {
    logger.warn('Database readiness check failed');
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});
