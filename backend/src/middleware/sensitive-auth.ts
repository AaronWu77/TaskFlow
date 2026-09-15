import { NextFunction, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest } from './auth';
import { prisma } from '../prisma-client';

export async function sensitiveAuthMiddleware(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.get('X-TaskFlow-Reauth');
  if (!token || !req.userId) {
    res.status(401).json({ code: 'RECENT_AUTH_REQUIRED', error: 'Recent authentication is required' });
    return;
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET!) as {
      userId?: string;
      purpose?: string;
      passwordChangedAt?: number;
    };
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { passwordChangedAt: true, deletedAt: true },
    });
    if (!user || user.deletedAt || payload.userId !== req.userId || payload.purpose !== 'sensitive'
      || payload.passwordChangedAt !== user.passwordChangedAt.getTime()) {
      res.status(401).json({ code: 'RECENT_AUTH_REQUIRED', error: 'Recent authentication is required' });
      return;
    }
    next();
  } catch {
    res.status(401).json({ code: 'RECENT_AUTH_REQUIRED', error: 'Recent authentication is required' });
  }
}
