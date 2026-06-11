import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const verificationCodes = new Map<string, { codeHash: string; expiresAt: number; attempts: number }>();
const rateLimits = new Map<string, { count: number; resetAt: number }>();

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

function createVerificationCode(email: string): string {
  const code = String(crypto.randomInt(100000, 1000000));
  verificationCodes.set(email, {
    codeHash: codeHash(email, code),
    expiresAt: Date.now() + VERIFICATION_TTL_MS,
    attempts: 0,
  });
  return code;
}

function consumeVerificationCode(email: string, code: string): boolean {
  const record = verificationCodes.get(email);
  if (!record || record.expiresAt < Date.now() || record.attempts >= 5) {
    verificationCodes.delete(email);
    return false;
  }
  record.attempts += 1;
  if (record.codeHash !== codeHash(email, code.trim())) return false;
  verificationCodes.delete(email);
  return true;
}

function clientKey(req: Request, scope: string, email?: string): string {
  return `${scope}:${req.ip}:${email ? normalizeEmail(email) : ''}`;
}

function checkRateLimit(key: string, max: number): boolean {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= now) {
    rateLimits.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (current.count >= max) return false;
  current.count += 1;
  return true;
}

function userPayload(user: { id: string; email: string; emailVerifiedAt: Date | null }) {
  return {
    id: user.id,
    email: user.email,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    emailVerified: !!user.emailVerifiedAt,
  };
}

async function issueSession(user: { id: string; email: string; emailVerifiedAt: Date | null }, res: Response, status = 200) {
  const accessToken = signAccess(user.id);
  const refreshToken = await createRefreshSession(user.id);
  res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
  res.status(status).json({ accessToken, refreshToken, user: userPayload(user) });
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
  const code = createVerificationCode(email);
  await sendVerificationCode(email, code);
  return process.env.NODE_ENV === 'production' ? {} : { devCode: code };
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
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email : '';
  const email = normalizeEmail(rawEmail);
  const { password } = req.body as { password?: string };
  if (!checkRateLimit(clientKey(req, 'register', email), 5)) {
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
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'Email already registered' });
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
  const { password } = req.body as { password?: string };
  if (!checkRateLimit(clientKey(req, 'login', email), 10)) {
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
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    res.status(401).json({ error: 'Invalid email or password' });
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
  await issueSession(user, res);
}));

// POST /auth/resend-verification
router.post('/resend-verification', asyncHandler(async (req, res) => {
  const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '');
  if (!checkRateLimit(clientKey(req, 'verify-resend', email), 5)) {
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
  if (!checkRateLimit(clientKey(req, 'verify-email', email), 10)) {
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
  if (!user.emailVerifiedAt && !consumeVerificationCode(email, code)) {
    res.status(400).json({ code: 'INVALID_VERIFICATION_CODE', error: 'Invalid or expired verification code' });
    return;
  }
  const verifiedUser = user.emailVerifiedAt
    ? user
    : await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } });
  await issueSession(verifiedUser, res);
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
    res.json({ accessToken, refreshToken, user: userPayload(session.user) });
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
