/**
 * CoachPilot AI — Step 1: WhatsApp Cloud API webhook server entry point.
 */

import path from 'path';
import dotenv from 'dotenv';
import express, { Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import webhookRoutes from './routes/webhook';
import oauthRoutes from './routes/oauthRoutes';
import adminRoutes from './routes/adminRoutes';
import coachRoutes from './routes/coachRoutes';
import { logger } from './services/logger';
import { runStartupChecks } from './config/startupChecks';

dotenv.config();

// Abort boot on unsafe/unusable configuration (throws in production).
runStartupChecks();

const PORT = Number(process.env.PORT ?? 3001);

if (!process.env.WHATSAPP_VERIFY_TOKEN) {
  logger.warn(
    'WHATSAPP_VERIFY_TOKEN is not set. Webhook verification will fail until it is configured in .env.',
  );
}

const app = express();

// Server-rendered onboarding dashboard (EJS). Views live in src/views and are
// resolved from the project root so this works under both ts-node and dist.
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'src', 'views'));

// Capture the raw request body so we can verify Meta's X-Hub-Signature-256.
// Cap the body size — webhook payloads are small; reject anything oversized.
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'CoachPilot AI',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV ?? 'development',
  });
});

app.use('/', adminRoutes);
app.use('/', coachRoutes);
app.use('/', oauthRoutes);
app.use('/', webhookRoutes);

const server = app.listen(PORT, () => {
  logger.info(`CoachPilot AI webhook server listening on port ${PORT}.`);
});

/**
 * Gracefully shut down on process signals so in-flight requests can finish and
 * the port is released cleanly (important for Render/Railway redeploys).
 */
function shutdown(signal: string): void {
  logger.info(`[SHUTDOWN] Received ${signal}. Closing HTTP server...`);

  server.close((error?: Error) => {
    if (error) {
      logger.error('[SHUTDOWN] Error while closing server.', error);
      process.exit(1);
    }
    logger.info('[SHUTDOWN] HTTP server closed. Exiting.');
    process.exit(0);
  });

  // Safety net: force-exit if connections do not drain in time.
  setTimeout(() => {
    logger.error('[SHUTDOWN] Forced exit after timeout (10s).');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;
