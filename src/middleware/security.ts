import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logEvent } from '../lib/logger.ts';
import { metrics } from '../lib/metrics.ts';

export interface ContextualRequest extends Request {
  requestId?: string;
}

export function requestContextMiddleware(
  req: ContextualRequest,
  res: Response,
  next: NextFunction,
): void {
  const incomingId = req.header('x-request-id');
  const requestId =
    incomingId && /^[a-zA-Z0-9._-]{4,64}$/.test(incomingId)
      ? incomingId
      : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    metrics.incHttpRequest(res.statusCode);
    if (req.path.startsWith('/api')) {
      logEvent(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
      });
    }
  });

  next();
}

export function securityHeadersMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.secure || req.header('x-forwarded-proto') === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

function getAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const appUrl = process.env.APP_URL;
  if (appUrl && appUrl !== 'MY_APP_URL') {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      // Ignore invalid placeholder URL
    }
  }
  const extra = process.env.ALLOWED_ORIGINS ?? '';
  for (const raw of extra.split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Ignore malformed origin entry
    }
  }
  if (process.env.NODE_ENV !== 'production') {
    origins.add('http://localhost:3000');
    origins.add('http://127.0.0.1:3000');
  }
  return origins;
}

export function corsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const origin = req.header('origin');
  if (origin) {
    const allowed = getAllowedOrigins();
    const requestHost = req.header('x-forwarded-host') || req.header('host');
    let isSameOrigin = false;
    if (requestHost) {
      try {
        isSameOrigin = new URL(origin).host === requestHost;
      } catch {
        isSameOrigin = false;
      }
    }

    if (isSameOrigin || allowed.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Edge-Credential-Id, X-Edge-Secret, Idempotency-Key, X-Request-Id',
      );
      res.setHeader('Access-Control-Max-Age', '600');
    } else if (req.path.startsWith('/api')) {
      res.status(403).json({
        error: {
          code: 'CORS_ORIGIN_DENIED',
          message: 'Origin is not permitted',
          requestId: (req as ContextualRequest).requestId,
        },
      });
      return;
    }
  }

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export function createRateLimiter(options: {
  windowMs: number;
  maxRequests: number;
  keyPrefix: string;
}) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const ip =
      (req.header('x-forwarded-for') ?? req.socket.remoteAddress ?? 'unknown')
        .split(',')[0]
        .trim();
    const credId = req.header('x-edge-credential-id') ?? '';
    const key = `${options.keyPrefix}:${credId || ip}`;

    const existing = hits.get(key);
    if (!existing || now >= existing.resetAt) {
      hits.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    existing.count += 1;
    if (existing.count > options.maxRequests) {
      const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED',
          message: 'Too many requests, please retry later',
          requestId: (req as ContextualRequest).requestId,
        },
      });
      return;
    }

    next();
  };
}
