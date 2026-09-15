import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import authRouter from './routes/auth';
import tasksRouter from './routes/tasks';
import userRouter from './routes/user';
import syncRouter from './routes/sync';
import { prisma } from './prisma-client';
import { runMaintenance } from './services/maintenance';
import { metricsSnapshot, recordHttpMetric } from './services/metrics';

const REQUIRED_SECRETS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;
for (const name of REQUIRED_SECRETS) {
  if (!process.env[name] || process.env[name]!.length < 32) {
    throw new Error(`${name} must be configured with at least 32 characters`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use((req, res, next) => {
  const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].slice(0, 120) : randomUUID();
  const startedAt = performance.now();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    const durationMs = performance.now() - startedAt;
    recordHttpMetric(res.statusCode, durationMs);
    console.log(JSON.stringify({
      level: 'info',
      event: 'http_request',
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 10) / 10,
    }));
  });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'true') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(cors({
  origin: (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173').split(','),
  credentials: true,
}));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

app.get(['/live', '/v1/live'], (_req, res) => {
  res.json({ status: 'ok' });
});

async function readinessHandler(_req: express.Request, res: express.Response): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
}

app.get(['/ready', '/v1/ready'], readinessHandler);
app.get(['/health', '/v1/health'], readinessHandler);

app.get(['/ops/metrics', '/v1/ops/metrics'], (req, res) => {
  const expectedToken = process.env.OPS_METRICS_TOKEN;
  if (!expectedToken) {
    res.status(404).json({ code: 'NOT_FOUND' });
    return;
  }
  if (req.get('Authorization') !== `Bearer ${expectedToken}`) {
    res.status(401).json({ code: 'UNAUTHORIZED' });
    return;
  }
  res.json(metricsSnapshot());
});

app.use('/auth', authRouter);
app.use('/tasks', tasksRouter);
app.use('/sync', syncRouter);
app.use('/user', userRouter);
app.use('/v1/auth', authRouter);
app.use('/v1/tasks', tasksRouter);
app.use('/v1/sync', syncRouter);
app.use('/v1/user', userRouter);

app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', error: 'Route not found' });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({
    level: 'error',
    event: 'http_error',
    requestId: res.locals.requestId,
    error: error instanceof Error ? error.message : String(error),
  }));
  res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Internal server error', requestId: res.locals.requestId });
});

const server = app.listen(PORT, () => {
  console.log(`TaskFlow API running on port ${PORT}`);
});

const MAINTENANCE_INTERVAL_MS = 6 * 60 * 60 * 1000;
function scheduleMaintenance(): void {
  void runMaintenance().catch(error => {
    console.error(JSON.stringify({
      level: 'error',
      event: 'maintenance_failed',
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}
scheduleMaintenance();
const maintenanceTimer = setInterval(scheduleMaintenance, MAINTENANCE_INTERVAL_MS);
maintenanceTimer.unref();

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(maintenanceTimer);
  console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(async () => {
    await prisma.$disconnect();
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
