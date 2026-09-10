import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRouter from './routes/auth';
import tasksRouter from './routes/tasks';
import userRouter from './routes/user';
import syncRouter from './routes/sync';
import { prisma } from './prisma-client';

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

app.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use('/auth', authRouter);
app.use('/tasks', tasksRouter);
app.use('/sync', syncRouter);
app.use('/user', userRouter);

app.use((_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', error: 'Route not found' });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('TaskFlow API request failed', error);
  res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`TaskFlow API running on port ${PORT}`);
});
