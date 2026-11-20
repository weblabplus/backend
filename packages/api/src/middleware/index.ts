import { Request, Response, NextFunction } from 'express';
import { getAuthSession } from '../services/auth.service';
import { dbService } from '../db/db.service';

// Extend Express Request για προσθήκη user
declare global {
  namespace Express {
    interface Request {
      user?: {
        uid: string;
        /** Better Auth user id (πίνακας "user") */
        authUserId?: string;
        email: string;
        role: string;
        displayName?: string;
        sessionToken?: string;
      };
    }
  }
}

/**
 * Better Auth middleware
 * Επαληθεύει το session (Authorization: Bearer <token>) και προσθέτει user info στο request
 */
export function authMiddleware(optional: boolean = false) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      if (optional) {
        return next();
      }
      res.status(401).json({
        error: 'Απαιτείται αυθεντικοποίηση',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    try {
      const session = await getAuthSession(req);

      if (!session) {
        if (optional) {
          return next();
        }
        res.status(401).json({
          error: 'Μη έγκυρο ή ληγμένο token αυθεντικοποίησης',
          code: 'AUTH_INVALID',
        });
        return;
      }

      const profile = await dbService.getUserProfileByEmail(session.user.email);

      req.user = {
        uid: profile?.uid || session.user.id,
        authUserId: profile?.id || session.user.id,
        email: session.user.email,
        role: profile?.role || 'doctor',
        displayName: profile?.displayName || session.user.name,
        sessionToken: session.session.token,
      };

      next();
    } catch {
      if (optional) {
        return next();
      }
      res.status(401).json({
        error: 'Μη έγκυρο token αυθεντικοποίησης',
        code: 'AUTH_INVALID',
      });
    }
  };
}

/**
 * Role-based access control middleware
 * Ελέγχει αν ο χρήστης έχει τον απαραίτητο ρόλο
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Απαιτείται αυθεντικοποίηση',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: 'Δεν έχετε τα απαραίτητα δικαιώματα',
        code: 'FORBIDDEN',
        requiredRoles: roles,
        userRole: req.user.role,
      });
      return;
    }

    next();
  };
}

/**
 * Request logging middleware
 */
export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  const timestamp = new Date().toISOString();
  const user = req.user ? `${req.user.role}:${req.user.email}` : 'anonymous';
  console.log(`[${timestamp}] ${req.method} ${req.path} [${user}]`);
  next();
}

/**
 * Rate limiting middleware (simple in-memory implementation)
 */
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export function rateLimiter(maxRequests: number = 100, windowMs: number = 60000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.user?.uid || req.ip || 'unknown';
    const now = Date.now();
    const entry = requestCounts.get(key);

    if (!entry || now > entry.resetTime) {
      requestCounts.set(key, { count: 1, resetTime: now + windowMs });
      next();
      return;
    }

    if (entry.count >= maxRequests) {
      res.status(429).json({
        error: 'Πάρα πολλά αιτήματα. Δοκιμάστε ξανά αργότερα.',
        retryAfter: Math.ceil((entry.resetTime - now) / 1000),
      });
      return;
    }

    entry.count++;
    next();
  };
}
