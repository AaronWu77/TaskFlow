import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

/** Wraps an async route handler so unhandled rejections propagate to Express error middleware */
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function signAccess(userId: string) {
  return jwt.sign({ userId }, process.env.JWT_ACCESS_SECRET!, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  } as jwt.SignOptions);
}

function signRefresh(userId: string) {
  return jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET!, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  } as jwt.SignOptions);
}

const REFRESH_COOKIE = 'taskflow_refresh';
// Use COOKIE_SECURE=true only when serving over HTTPS; keep false for plain HTTP deployments
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'strict' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
};
// Matching options for clearCookie (without maxAge)
const CLEAR_COOKIE_OPTS = { httpOnly: COOKIE_OPTS.httpOnly, secure: COOKIE_OPTS.secure, sameSite: COOKIE_OPTS.sameSite };

// POST /auth/register
router.post('/register', asyncHandler(async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }
  const hashed = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({ data: { email, password: hashed } });
  const accessToken = signAccess(user.id);
  const refreshToken = signRefresh(user.id);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
  res.status(201).json({ accessToken, user: { id: user.id, email: user.email } });
}));

// POST /auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  const accessToken = signAccess(user.id);
  const refreshToken = signRefresh(user.id);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
  res.json({ accessToken, user: { id: user.id, email: user.email } });
}));

// POST /auth/refresh
router.post('/refresh', (req: Request, res: Response): void => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'No refresh token' });
    return;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as { userId: string };
    const accessToken = signAccess(payload.userId);
    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// POST /auth/logout
router.post('/logout', (_req: Request, res: Response): void => {
  res.clearCookie(REFRESH_COOKIE, CLEAR_COOKIE_OPTS);
  res.json({ ok: true });
});

export default router;
