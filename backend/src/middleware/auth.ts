import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma-client';

export interface AuthRequest extends Request {
  userId?: string;
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as {
      userId: string;
      authVersion?: number;
      sessionId?: string;
    };
    const [user, session] = await Promise.all([
      prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true, deletedAt: true, authVersion: true },
      }),
      payload.sessionId
        ? prisma.refreshSession.findFirst({
          where: {
            id: payload.sessionId,
            userId: payload.userId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
          select: { id: true },
        })
        : Promise.resolve(null),
    ]);
    const versionMatches = user
      && (payload.authVersion === user.authVersion
        || (payload.authVersion === undefined && user.authVersion === 1));
    const sessionMatches = payload.sessionId ? !!session : payload.authVersion === undefined;
    if (!user || user.deletedAt || !versionMatches || !sessionMatches) {
      res.status(401).json({ error: 'Invalid or expired access token' });
      return;
    }
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired access token' });
  }
}
