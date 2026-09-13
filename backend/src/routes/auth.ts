import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma-client';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

function codeHash(email: string, code: string): string {
  return crypto.createHash('sha256').update(`${email}:${code}:${process.env.JWT_REFRESH_SECRET}`).digest('hex');
}

async function createVerificationCode(email: string): Promise<string> {
  const code = String(crypto.randomInt(100000, 1000000));
  await prisma.emailVerification.upsert({
    where: { email },
    create: { email, codeHash: codeHash(email, code), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
    update: { codeHash: codeHash(email, code), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS), attempts: 0 },
  });
  return code;
}

async function consumeVerificationCode(email: string, code: string): Promise<boolean> {
  const now = new Date();
  const expectedHash = codeHash(email, code.trim());
  const matched = await prisma.emailVerification.updateMany({
    where: { email, codeHash: expectedHash, expiresAt: { gt: now }, attempts: { lt: 5 } },
    data: { attempts: { increment: 1 } },
  });
  if (matched.count === 1) {
    await prisma.emailVerification.deleteMany({ where: { email } });
    return true;
  }
  await prisma.emailVerification.updateMany({
    where: { email, expiresAt: { gt: now }, attempts: { lt: 5 } },
    data: { attempts: { increment: 1 } },
  });
  return false;
}

function clientKey(req: Request, scope: string, email?: string): string {
  return `${scope}:${req.ip}:${email ? normalizeEmail(email) : ''}`;
}

async function checkRateLimit(key: string, max: number): Promise<boolean> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + RATE_LIMIT_WINDOW_MS);
  const rows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    INSERT INTO "RateLimitBucket" ("key", "count", "resetAt", "updatedAt")
    VALUES (${key}, 1, ${resetAt}, ${now})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now} THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
      "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now} THEN ${resetAt} ELSE "RateLimitBucket"."resetAt" END,
      "updatedAt" = ${now}
    RETURNING "count"
  `);
  return (rows[0]?.count ?? max + 1) <= max;
}

function userPayload(user: { id: string; email: string; emailVerifiedAt: Date | null; displayName?: string | null; timezone?: string | null; locale?: string | null }) {
  return {
    id: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    emailVerified: !!user.emailVerifiedAt,
    displayName: user.displayName ?? null,
    timezone: user.timezone ?? null,
    locale: user.locale ?? null,
  };
}

function includeRefreshTokenInBody(req: Request): boolean {
  const origin = req.get('Origin');
  const allowedNativeOrigins = (process.env.NATIVE_APP_ORIGINS || 'capacitor://localhost,ionic://localhost').split(',');
  return req.get('X-TaskFlow-Platform') === 'native' && !!origin && allowedNativeOrigins.includes(origin);
}

async function issueSession(user: { id: string; email: string; emailVerifiedAt: Date | null; displayName?: string | null; timezone?: string | null; locale?: string | null }, req: Request, res: Response, status = 200) {
  const accessToken = signAccess(user.id);
  const refreshToken = await createRefreshSession(user.id);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
  res.status(status).json({
    accessToken,
    ...(includeRefreshTokenInBody(req) ? { refreshToken } : {}),
    user: userPayload(user),
  });
}

async function sendVerificationCode(email: string, code: string): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const emailFrom = process.env.EMAIL_FROM || 'TaskFlow <verify@taskflow.top>';
  if (resendApiKey) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: emailFrom,
        to: [email],
        subject: 'Your TaskFlow verification code',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #111827;">
            <h1 style="font-size: 20px; margin: 0 0 12px;">Verify your TaskFlow account</h1>
            <p style="margin: 0 0 16px;">Enter this code in TaskFlow to finish signing in:</p>
            <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.2em; margin: 0 0 16px;">${code}</p>
            <p style="margin: 0; color: #6b7280;">This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>
          </div>
        `,
        text: `Your TaskFlow verification code is ${code}. It expires in 10 minutes.`,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend email delivery failed: ${detail}`);
    }
    return;
  }

  const webhookUrl = process.env.EMAIL_VERIFICATION_WEBHOOK_URL;
  if (webhookUrl) {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.EMAIL_VERIFICATION_WEBHOOK_TOKEN
          ? { Authorization: `Bearer ${process.env.EMAIL_VERIFICATION_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({
        to: email,
        subject: 'Your TaskFlow verification code',
        text: `Your TaskFlow verification code is ${code}. It expires in 10 minutes.`,
      }),
    });
    if (!response.ok) throw new Error('Email verification webhook failed');
    return;
  }

  const allowConsoleDelivery = process.env.NODE_ENV !== 'production' || process.env.EMAIL_VERIFICATION_CONSOLE === 'true';
  if (!allowConsoleDelivery) {
    throw new Error('Email delivery is not configured');
  }
  console.log(`TaskFlow email verification code for ${email}: ${code}`);
}

async function startEmailVerification(email: string): Promise<{ devCode?: string }> {
  const code = await createVerificationCode(email);
  await sendVerificationCode(email, code);
  return process.env.NODE_ENV === 'production' ? {} : { devCode: code };
}

function refreshTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function refreshTtlMs(): number {
  const raw = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
  const match = /^(\d+)([smhd])$/.exec(raw);
  const amount = match ? Number(match[1]) : 7;
  const unit = match?.[2] ?? 'd';
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * factor;
}

function refreshExpiry(): Date {
  return new Date(Date.now() + refreshTtlMs());
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
  const now = new Date();
  const revokedRetention = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await prisma.$transaction([
    prisma.refreshSession.deleteMany({
      where: {
        userId,
        OR: [
          { expiresAt: { lt: now } },
          { revokedAt: { lt: revokedRetention } },
        ],
      },
    }),
    prisma.refreshSession.create({
      data: {
        userId,
        tokenHash: session.tokenHash,
        expiresAt: session.expiresAt,
      },
    }),
  ]);
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
  maxAge: refreshTtlMs(),
};
// Matching options for clearCookie (without maxAge)
const CLEAR_COOKIE_OPTS = { httpOnly: COOKIE_OPTS.httpOnly, secure: COOKIE_OPTS.secure, sameSite: COOKIE_OPTS.sameSite };

// POST /auth/register
router.post('/register', asyncHandler(async (req, res) => {
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  const email = normalizeEmail(rawEmail);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!(await checkRateLimit(clientKey(req, 'register', email), 5))) {
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many registration attempts. Please try again later.' });
    return;
  }
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  if (!isValidEmail(email)) {
    res.status(400).json({ code: 'INVALID_EMAIL', error: 'Enter a valid email address' });
    return;
  }
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    res.status(400).json({ code: 'WEAK_PASSWORD', error: 'Password must be 8-128 characters and include a letter and a number' });
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ code: 'EMAIL_EXISTS', error: 'Email already registered' });
    return;
  }
  try {
    const verification = await startEmailVerification(email);
    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data: { email, password: hashed } });
    res.status(201).json({
      requiresEmailVerification: true,
      user: userPayload(user),
      ...verification,
    });
  } catch (err) {
    console.error('TaskFlow email verification delivery failed:', err);
    res.status(503).json({ code: 'EMAIL_DELIVERY_FAILED', error: 'Email verification delivery failed' });
  }
}));

// POST /auth/login
router.post('/login', asyncHandler(async (req, res) => {
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  const email = normalizeEmail(rawEmail);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!(await checkRateLimit(clientKey(req, 'login', email), 10))) {
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many login attempts. Please try again later.' });
    return;
  }
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }
  if (!isValidEmail(email)) {
    res.status(400).json({ code: 'INVALID_EMAIL', error: 'Enter a valid email address' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Invalid email or password' });
    return;
  }
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Invalid email or password' });
    return;
  }
  if (user.deletedAt) {
    res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Invalid email or password' });
    return;
  }
  if (!user.emailVerifiedAt) {
    try {
      const verification = await startEmailVerification(user.email);
      res.status(403).json({
        code: 'EMAIL_NOT_VERIFIED',
        error: 'Verify your email before signing in',
        requiresEmailVerification: true,
        user: userPayload(user),
        ...verification,
      });
    } catch (err) {
      console.error('TaskFlow email verification delivery failed:', err);
      res.status(503).json({ code: 'EMAIL_DELIVERY_FAILED', error: 'Email verification delivery failed' });
    }
    return;
  }
  const loggedInUser = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await issueSession(loggedInUser, req, res);
}));

// POST /auth/resend-verification
router.post('/resend-verification', asyncHandler(async (req, res) => {
  const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '');
  if (!(await checkRateLimit(clientKey(req, 'verify-resend', email), 5))) {
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many verification requests. Please try again later.' });
    return;
  }
  if (!isValidEmail(email)) {
    res.status(400).json({ code: 'INVALID_EMAIL', error: 'Enter a valid email address' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(404).json({ code: 'USER_NOT_FOUND', error: 'Account not found' });
    return;
  }
  if (user.deletedAt) {
    res.status(404).json({ code: 'USER_NOT_FOUND', error: 'Account not found' });
    return;
  }
  if (user.emailVerifiedAt) {
    res.json({ ok: true, alreadyVerified: true });
    return;
  }
  try {
    const verification = await startEmailVerification(user.email);
    res.json({ ok: true, ...verification });
  } catch (err) {
    console.error('TaskFlow email verification delivery failed:', err);
    res.status(503).json({ code: 'EMAIL_DELIVERY_FAILED', error: 'Email verification delivery failed' });
  }
}));

// POST /auth/verify-email
router.post('/verify-email', asyncHandler(async (req, res) => {
  const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '');
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  if (!(await checkRateLimit(clientKey(req, 'verify-email', email), 10))) {
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many verification attempts. Please try again later.' });
    return;
  }
  if (!isValidEmail(email) || !/^\d{6}$/.test(code.trim())) {
    res.status(400).json({ code: 'INVALID_VERIFICATION_CODE', error: 'Enter the 6-digit verification code' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(404).json({ code: 'USER_NOT_FOUND', error: 'Account not found' });
    return;
  }
  if (user.deletedAt) {
    res.status(404).json({ code: 'USER_NOT_FOUND', error: 'Account not found' });
    return;
  }
  if (!user.emailVerifiedAt && !(await consumeVerificationCode(email, code))) {
    res.status(400).json({ code: 'INVALID_VERIFICATION_CODE', error: 'Invalid or expired verification code' });
    return;
  }
  const verifiedUser = user.emailVerifiedAt
    ? user
    : await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  const loggedInUser = await prisma.user.update({ where: { id: verifiedUser.id }, data: { lastLoginAt: new Date() } });
  await issueSession(loggedInUser, req, res);
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
    if (!session || session.userId !== payload.userId || session.revokedAt || session.expiresAt <= new Date() || session.user.deletedAt) {
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
    res.json({
      accessToken,
      ...(includeRefreshTokenInBody(req) ? { refreshToken } : {}),
      user: userPayload(session.user),
    });
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
