import { Response } from 'express';

/** Error with a stable machine code. Messages are written for people and never include internals. */
export class IntegrationError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>) {
    super(message);
  }
}

export const bad = (message: string, details?: Record<string, unknown>) => new IntegrationError(400, 'VALIDATION_ERROR', message, details);

export function sendError(res: Response, err: IntegrationError): void {
  res.locals.integrationErrorCode = err.code;
  res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
}
