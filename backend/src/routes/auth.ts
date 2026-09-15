import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma-client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const REFRESH_ROTATION_GRACE_MS = 5_000;

class RefreshRotationRaceError extends Error {}

/** Wraps an async route handler so unhandled rejections propagate to Express error middleware */
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function signAccess(userId: string, authVersion: number, sessionId: string) {
  return jwt.sign({ userId, authVersion, sessionId }, process.env.JWT_ACCESS_SECRET!, {
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

async function issueSession(user: { id: string; email: string; emailVerifiedAt: Date | null; authVersion: number; displayName?: string | null; timezone?: string | null; locale?: string | null }, req: Request, res: Response, status = 200) {
  const refreshSession = await createRefreshSession(user.id, req);
  const accessToken = signAccess(user.id, user.authVersion, refreshSession.id);
  res.cookie(REFRESH_COOKIE, refreshSession.token, COOKIE_OPTS);
  res.status(status).json({
    accessToken,
    ...(includeRefreshTokenInBody(req) ? { refreshToken: refreshSession.token } : {}),
    user: userPayload(user),
  });
}

type AuthCodePurpose = 'verification' | 'password-reset' | 'account-restore';

async function sendAuthCode(email: string, code: string, purpose: AuthCodePurpose): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const emailFrom = process.env.EMAIL_FROM || 'TaskFlow <verify@taskflow.top>';
  const subject = purpose === 'verification'
    ? 'Your TaskFlow verification code'
    : purpose === 'password-reset'
      ? 'Reset your TaskFlow password'
      : 'Restore your TaskFlow account';
  const instruction = purpose === 'verification'
    ? 'finish signing in'
    : purpose === 'password-reset'
      ? 'reset your password'
      : 'restore your account';
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
        subject,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; color: #111827;">
            <h1 style="font-size: 20px; margin: 0 0 12px;">${subject}</h1>
            <p style="margin: 0 0 16px;">Enter this code in TaskFlow to ${instruction}:</p>
            <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.2em; margin: 0 0 16px;">${code}</p>
            <p style="margin: 0; color: #6b7280;">This code expires in 10 minutes. If you did not request it, you can ignore this email.</p>
          </div>
        `,
        text: `Your TaskFlow code to ${instruction} is ${code}. It expires in 10 minutes.`,
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
        subject,
        text: `Your TaskFlow code to ${instruction} is ${code}. It expires in 10 minutes.`,
      }),
    });
    if (!response.ok) throw new Error('Email verification webhook failed');
    return;
  }

  const allowConsoleDelivery = process.env.NODE_ENV !== 'production' || process.env.EMAIL_VERIFICATION_CONSOLE === 'true';
  if (!allowConsoleDelivery) {
    throw new Error('Email delivery is not configured');
  }
  console.log(`TaskFlow ${purpose} code for ${email}: ${code}`);
}

async function startEmailVerification(email: string): Promise<{ devCode?: string }> {
  const code = await createVerificationCode(email);
  await sendAuthCode(email, code, 'verification');
  return process.env.NODE_ENV === 'production' ? {} : { devCode: code };
}

function passwordCodeHash(email: string, code: string): string {
  return crypto.createHash('sha256').update(`password:${email}:${code}:${process.env.JWT_REFRESH_SECRET}`).digest('hex');
}

async function createPasswordCode(email: string, purpose: Exclude<AuthCodePurpose, 'verification'>): Promise<string> {
  const code = String(crypto.randomInt(100000, 1000000));
  await prisma.passwordReset.upsert({
    where: { email },
    create: { email, codeHash: passwordCodeHash(email, code), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
    update: { codeHash: passwordCodeHash(email, code), expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS), attempts: 0 },
  });
  await sendAuthCode(email, code, purpose);
  return code;
}

async function consumePasswordCode(email: string, code: string): Promise<boolean> {
  const now = new Date();
  const matched = await prisma.passwordReset.updateMany({
    where: { email, codeHash: passwordCodeHash(email, code.trim()), expiresAt: { gt: now }, attempts: { lt: 5 } },
    data: { attempts: { increment: 1 } },
  });
  if (matched.count === 1) {
    await prisma.passwordReset.deleteMany({ where: { email } });
    return true;
  }
  await prisma.passwordReset.updateMany({
    where: { email, expiresAt: { gt: now }, attempts: { lt: 5 } },
    data: { attempts: { increment: 1 } },
  });
  return false;
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

function sessionMetadata(req: Request): { deviceName: string | null; platform: string | null } {
  const requestedName = req.get('X-TaskFlow-Device-Name')?.trim().slice(0, 80);
  const platform = req.get('X-TaskFlow-Platform')?.trim().slice(0, 40) || null;
  return {
    deviceName: requestedName || (platform === 'native' ? 'TaskFlow iOS' : 'TaskFlow Web'),
    platform,
  };
}

function buildRefreshSession(userId: string, req: Request, familyId: string = crypto.randomUUID()): { id: string; token: string; tokenHash: string; expiresAt: Date; familyId: string; deviceName: string | null; platform: string | null } {
  const refreshToken = signRefresh(userId);
  return {
    id: crypto.randomUUID(),
    token: refreshToken,
    tokenHash: refreshTokenHash(refreshToken),
    expiresAt: refreshExpiry(),
    familyId,
    ...sessionMetadata(req),
  };
}

async function createRefreshSession(userId: string, req: Request): Promise<ReturnType<typeof buildRefreshSession>> {
  const session = buildRefreshSession(userId, req);
  const now = new Date();
  const revokedRetention = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await prisma.$transaction(async tx => {
    await tx.refreshSession.deleteMany({
      where: {
        userId,
        OR: [
          { expiresAt: { lt: now } },
          { revokedAt: { lt: revokedRetention } },
        ],
      },
    });
    await tx.refreshSession.create({
      data: {
        id: session.id,
        userId,
        tokenHash: session.tokenHash,
        expiresAt: session.expiresAt,
        familyId: session.familyId,
        deviceName: session.deviceName,
        platform: session.platform,
        lastSeenAt: now,
      },
    });
    const active = await tx.refreshSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      select: { id: true },
    });
    if (active.length > 0) {
      await tx.refreshSession.updateMany({
        where: { id: { in: active.map(item => item.id) } },
        data: { revokedAt: now },
      });
    }
  });
  return session;
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
    res.status(403).json({
      code: 'ACCOUNT_PENDING_DELETION',
      error: 'Account is pending deletion',
      deleteScheduledFor: user.deleteScheduledFor?.toISOString() ?? null,
    });
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

// POST /auth/reauthenticate — issue a ten-minute grant for sensitive actions.
router.post('/reauthenticate', authMiddleware, asyncHandler(async (req, res) => {
  const userId = (req as AuthRequest).userId!;
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.deletedAt || !password || !(await bcrypt.compare(password, user.password))) {
    res.status(401).json({ code: 'INVALID_CREDENTIALS', error: 'Password is incorrect' });
    return;
  }
  const grant = jwt.sign({
    userId,
    purpose: 'sensitive',
    passwordChangedAt: user.passwordChangedAt.getTime(),
  }, process.env.JWT_ACCESS_SECRET!, { expiresIn: '10m' });
  res.json({ grant, expiresInSeconds: 600 });
}));

router.post('/password-reset/request', asyncHandler(async (req, res) => {
  const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '');
  if (!(await checkRateLimit(clientKey(req, 'password-reset-request', email), 5))) {
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many password reset requests' });
    return;
  }
  if (isValidEmail(email)) {
    const user = await prisma.user.findUnique({ where: { email }, select: { deletedAt: true } });
    if (user && !user.deletedAt) {
      try {
        const code = await createPasswordCode(email, 'password-reset');
        res.status(202).json({ ok: true, ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}) });
        return;
      } catch (error) {
        console.error('TaskFlow password reset delivery failed:', error);
      }
    }
  }
  res.status(202).json({ ok: true });
}));

router.post('/password-reset/confirm', asyncHandler(async (req, res) => {
  const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '');
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : '';
  if (!(await checkRateLimit(clientKey(req, 'password-reset-confirm', email), 10))) {
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many password reset attempts' });
    return;
  }
  if (!isValidEmail(email) || !/^\d{6}$/.test(code)
    || newPassword.length < 8 || newPassword.length > 128 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    res.status(400).json({ code: 'INVALID_PASSWORD_RESET', error: 'Invalid password reset request' });
    return;
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.deletedAt || !(await consumePasswordCode(email, code))) {
    res.status(400).json({ code: 'INVALID_PASSWORD_RESET', error: 'Invalid or expired reset code' });
    return;
  }
  const now = new Date();
  const password = await bcrypt.hash(newPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { password, passwordChangedAt: now, authVersion: { increment: 1 } } }),
    prisma.refreshSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: now } }),
  ]);
  res.json({ ok: true });
}));

router.post('/restore-account/request', asyncHandler(async (req, res) => {
  const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '');
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!(await checkRateLimit(clientKey(req, 'restore-account-request', email), 5))) {
    res.status(429).json({ code: 'RATE_LIMITED', error: 'Too many account restore requests' });
    return;
  }
  const user = isValidEmail(email) ? await prisma.user.findUnique({ where: { email } }) : null;
  if (user?.deletedAt && user.deleteScheduledFor && user.deleteScheduledFor > new Date()
    && password && await bcrypt.compare(password, user.password)) {
    try {
      const code = await createPasswordCode(email, 'account-restore');
      res.status(202).json({ ok: true, ...(process.env.NODE_ENV !== 'production' ? { devCode: code } : {}) });
      return;
    } catch (error) {
      console.error('TaskFlow account restore delivery failed:', error);
    }
  }
  res.status(202).json({ ok: true });
}));

router.post('/restore-account/confirm', asyncHandler(async (req, res) => {
  const email = normalizeEmail(typeof req.body?.email === 'string' ? req.body.email : '');
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const user = isValidEmail(email) ? await prisma.user.findUnique({ where: { email } }) : null;
  if (!user?.deletedAt || !user.deleteScheduledFor || user.deleteScheduledFor <= new Date()
    || !password || !/^\d{6}$/.test(code) || !(await bcrypt.compare(password, user.password))
    || !(await consumePasswordCode(email, code))) {
    res.status(400).json({ code: 'INVALID_ACCOUNT_RESTORE', error: 'Invalid or expired account restore request' });
    return;
  }
  const restored = await prisma.$transaction(async tx => {
    const restoredUser = await tx.user.update({
      where: { id: user.id },
      data: { deletedAt: null, deleteScheduledFor: null, lastLoginAt: new Date() },
    });
    await tx.accountDeletionAudit.create({
      data: {
        userId: user.id,
        emailHash: crypto.createHash('sha256').update(user.email).digest('hex'),
        action: 'restored',
      },
    });
    return restoredUser;
  });
  await issueSession(restored, req, res);
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
    if (session?.revokedAt && session.rotatedAt && session.reuseGraceUntil && session.reuseGraceUntil > new Date()) {
      res.status(409).json({ code: 'REFRESH_ROTATION_IN_PROGRESS', error: 'Refresh token was rotated by a concurrent request' });
      return;
    }
    if (session?.revokedAt && session.rotatedAt) {
      await prisma.refreshSession.updateMany({
        where: { userId: session.userId, familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      res.status(401).json({ code: 'REFRESH_REUSE_DETECTED', error: 'Refresh token reuse detected' });
      return;
    }
    if (!session || session.userId !== payload.userId || session.revokedAt || session.expiresAt <= new Date() || session.user.deletedAt) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    const nextSession = buildRefreshSession(payload.userId, req, session.familyId);
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      const revoked = await tx.refreshSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now, rotatedAt: now, reuseGraceUntil: new Date(now.getTime() + REFRESH_ROTATION_GRACE_MS) },
      });
      if (revoked.count !== 1) {
        throw new RefreshRotationRaceError('Refresh token already rotated');
      }
      await tx.refreshSession.create({
        data: {
          id: nextSession.id,
          userId: payload.userId,
          tokenHash: nextSession.tokenHash,
          expiresAt: nextSession.expiresAt,
          familyId: nextSession.familyId,
          deviceName: nextSession.deviceName,
          platform: nextSession.platform,
          lastSeenAt: now,
        },
      });
    });
    const accessToken = signAccess(payload.userId, session.user.authVersion, nextSession.id);
    const refreshToken = nextSession.token;
    res.cookie(REFRESH_COOKIE, refreshToken, COOKIE_OPTS);
    res.json({
      accessToken,
      ...(includeRefreshTokenInBody(req) ? { refreshToken } : {}),
      user: userPayload(session.user),
    });
  } catch (error) {
    if (error instanceof RefreshRotationRaceError) {
      res.status(409).json({ code: 'REFRESH_ROTATION_IN_PROGRESS', error: 'Refresh token was rotated by a concurrent request' });
      return;
    }
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
