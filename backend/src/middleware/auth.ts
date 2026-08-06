import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// `co` mirrors the live app's simple Holdings(1)/Original(other) company
// model (see index.html isHoldingsUser/belongsToUserCompany) — deliberately
// not `company_id` (a UUID FK into the separate, unused schema.sql
// `companies` table). Optional because most accounts (Original company,
// pre-Holdings) carry no `co` at all.
export interface AuthRequest extends Request {
  user?: { id: string; email: string; role: string; co?: number | null };
}

export const authenticate = (req: AuthRequest, res: Response, next: NextFunction): void => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    res.status(401).json({ error: 'No token provided' });
    return;
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret') as AuthRequest['user'];
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

export const requireRole = (...roles: string[]) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
