import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
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
  return jwt.sign({ userId, jti: crypto.randomUUID() }, process.env.JWT_REFRESH_SECRET!, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  } as jwt.SignOptions);
}

function refreshTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshExpiry(): Date {
  const raw = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
  const match = /^(\d+)([smhd])$/.exec(raw);
  const amount = match ? Number(match[1]) : 7;
  const unit = match?.[2] ?? 'd';
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return new Date(Date.now() + amount * factor);
}

function buildRefreshSession(userId: string): { token: string; tokenHash: string; expiresAt: Date } {
  const refreshToken = signRefresh(userId);
  return {
    token: refreshToken,
    tokenHash: refreshTokenHash(refreshToken),
    expiresAt: refreshExpiry(),
  };
}

async function createRefreshSession(userId: string): Promise<string> {
  const session = buildRefreshSession(userId);
  await prisma.refreshSession.create({
    data: {
      userId,
      tokenHash: session.tokenHash,
      expiresAt: session.expiresAt,
    },
  });
  return session.token;
}

function getRefreshToken(req: Request): string | null {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  return req.cookies?.[REFRESH_COOKIE] || bearer;
}

const REFRESH_COOKIE = 'taskflow_refresh';
// Use COOKIE_SECURE=true only when serving over HTTPS; keep false for plain HTTP deployments
// sameSite 'lax' allows the cookie to persist across top-level navigations (browser restart)
// while still protecting against CSRF from cross-origin POST requests.
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'lax' as const,
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
  const refreshToken = await createRefreshSession(user.id);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
  res.status(201).json({ accessToken, refreshToken, user: { id: user.id, email: user.email } });
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
  const refreshToken = await createRefreshSession(user.id);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
  res.json({ accessToken, refreshToken, user: { id: user.id, email: user.email } });
}));

// POST /auth/refresh
router.post('/refresh', asyncHandler(async (req, res) => {
  const token = getRefreshToken(req);
  if (!token) {
    res.status(401).json({ error: 'No refresh token' });
    return;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as { userId: string };
    const session = await prisma.refreshSession.findUnique({
      where: { tokenHash: refreshTokenHash(token) },
      include: { user: true },
    });
    if (!session || session.userId !== payload.userId || session.revokedAt || session.expiresAt <= new Date()) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    const accessToken = signAccess(payload.userId);
    const nextSession = buildRefreshSession(payload.userId);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, rotatedAt: now },
      });
      if (revoked.count !== 1) {
        throw new Error('Refresh token already rotated');
      }
      await tx.refreshSession.create({
        data: {
          userId: payload.userId,
          tokenHash: nextSession.tokenHash,
          expiresAt: nextSession.expiresAt,
        },
      });
    });
    const refreshToken = nextSession.token;
    res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
    res.json({ accessToken, refreshToken, user: { id: session.user.id, email: session.user.email } });
  } catch {
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
}));

// POST /auth/logout
router.post('/logout', asyncHandler(async (req, res) => {
  const token = getRefreshToken(req);
  if (token) {
    await prisma.refreshSession.updateMany({
      where: { tokenHash: refreshTokenHash(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  res.clearCookie(REFRESH_COOKIE, CLEAR_COOKIE_OPTS);
  res.json({ ok: true });
}));

export default router;
