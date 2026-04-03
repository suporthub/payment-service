import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { AppError } from '../utils/errors';
import { AuthenticatedUser } from '../types/payment.types';

// Augment Express Request to carry the authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

interface JwtPayload {
  userId:   string;
  userType: string;
  email?:   string;
  role?:    string;
}

/**
 * requireAuth — verifies the JWT issued by auth-service.
 * The shared JWT_SECRET means no round-trip to auth-service is needed.
 */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers['authorization'] ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) throw new AppError('UNAUTHENTICATED', 401, 'Authorization token required');

  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    req.user = {
      userId:   payload.userId,
      userType: payload.userType,
      email:    payload.email,
      role:     payload.role,
    };
    next();
  } catch {
    throw new AppError('INVALID_TOKEN', 401, 'Invalid or expired token');
  }
}

/**
 * requireAdmin — verifies the ADMIN JWT issued by the admin auth flow.
 * Uses a separate ADMIN_JWT_SECRET for additional isolation.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers['authorization'] ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) throw new AppError('UNAUTHENTICATED', 401, 'Admin token required');

  try {
    const payload = jwt.verify(token, config.ADMIN_JWT_SECRET) as JwtPayload;
    if (payload.role !== 'admin' && payload.role !== 'superadmin') {
      throw new AppError('FORBIDDEN', 403, 'Admin access required');
    }
    req.user = {
      userId:   payload.userId,
      userType: 'admin',
      email:    payload.email,
      role:     payload.role,
    };
    next();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('INVALID_TOKEN', 401, 'Invalid or expired admin token');
  }
}

/**
 * requireInternalSecret — verifies the x-service-secret header for internal
 * service-to-service calls (user-service confirming wallet credit, etc.)
 */
export function requireInternalSecret(req: Request, _res: Response, next: NextFunction): void {
  const secret = req.headers['x-service-secret'];
  if (secret !== config.INTERNAL_SERVICE_SECRET) {
    throw new AppError('FORBIDDEN', 403, 'Invalid internal service secret');
  }
  next();
}
