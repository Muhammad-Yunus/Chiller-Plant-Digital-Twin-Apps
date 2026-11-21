import crypto from 'crypto';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { getApps } from 'firebase-admin/app';
import openApiSpec from '../../docs/openapi.json' with { type: 'json' };
import { pool } from '../db/index.ts';
import {
  acknowledgeAlarm,
  assignPlantMember,
  clearAlarm,
  createOrRotateEdgeCredential,
  DomainError,
  getDeviceTrends,
  getPlantAlarms,
  getPlantSnapshot,
  ingestTelemetryBatch,
  listEdgeCredentials,
} from '../db/plantRepository.ts';
import { logEvent } from '../lib/logger.ts';
import { metrics } from '../lib/metrics.ts';
import { type PlantTelemetryStreamEvent, realtimeBus } from '../lib/realtimeBus.ts';
import {
  type AuthRequest,
  requireEdgeAuth,
  requireOperatorAuth,
  requirePlantRole,
} from '../middleware/auth.ts';
import {
  type ContextualRequest,
  corsMiddleware,
  createRateLimiter,
  requestContextMiddleware,
  securityHeadersMiddleware,
} from '../middleware/security.ts';
import type { UserRole } from '../types/plant.ts';
import {
  deviceIdSchema,
  edgeCredentialCreateSchema,
  memberAssignSchema,
  telemetryIngestSchema,
} from '../validation/telemetrySchemas.ts';

export interface AppDependencies {
  checkReadiness?: () => Promise<{
    ready: boolean;
    checks: { database: 'ok' | 'unavailable'; auth: 'ok' | 'unavailable' };
  }>;
  requireOperatorAuth?: RequestHandler;
  requirePlantRole?: (minRole: UserRole) => RequestHandler;
  requireEdgeAuth?: RequestHandler;
  repo?: {
    getPlantSnapshot: typeof getPlantSnapshot;
    getDeviceTrends: typeof getDeviceTrends;
    getPlantAlarms: typeof getPlantAlarms;
    acknowledgeAlarm: typeof acknowledgeAlarm;
    clearAlarm: typeof clearAlarm;
    ingestTelemetryBatch: typeof ingestTelemetryBatch;
    createOrRotateEdgeCredential: typeof createOrRotateEdgeCredential;
    listEdgeCredentials: typeof listEdgeCredentials;
    assignPlantMember: typeof assignPlantMember;
  };
  subscribePlantStream?: (
    plantId: number,
    listener: (event: PlantTelemetryStreamEvent) => void,
  ) => () => void;
  apiRateLimitMax?: number;
  ingestRateLimitMax?: number;
}

async function defaultCheckReadiness() {
  let dbOk: 'ok' | 'unavailable' = 'unavailable';
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB readiness timeout')), 3000),
      ),
    ]);
    dbOk = 'ok';
  } catch {
    dbOk = 'unavailable';
  }

  const authOk: 'ok' | 'unavailable' = getApps().length > 0 ? 'ok' : 'unavailable';
  return {
    ready: dbOk === 'ok' && authOk === 'ok',
    checks: { database: dbOk, auth: authOk },
  };
}

function formatError(
  res: Response,
  req: ContextualRequest,
  status: number,
  code: string,
  message: string,
  details?: Array<{ path: string; message: string }>,
) {
  res.status(status).json({
    error: {
      code,
      message,
      requestId: req.requestId,
      ...(details ? { details } : {}),
    },
  });
}

function safeTokenMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createApp(deps: AppDependencies = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const activeSseResponses = new Set<Response>();

  const repo = deps.repo ?? {
    getPlantSnapshot,
    getDeviceTrends,
    getPlantAlarms,
    acknowledgeAlarm,
    clearAlarm,
    ingestTelemetryBatch,
    createOrRotateEdgeCredential,
    listEdgeCredentials,
    assignPlantMember,
  };

  const checkReadiness = deps.checkReadiness ?? defaultCheckReadiness;
  const operatorAuth = deps.requireOperatorAuth ?? requireOperatorAuth;
  const plantRole = deps.requirePlantRole ?? requirePlantRole;
  const edgeAuth = deps.requireEdgeAuth ?? requireEdgeAuth;
  const subscribeStream =
    deps.subscribePlantStream ??
    ((plantId, listener) => realtimeBus.subscribe(plantId, listener));

  const apiLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests: deps.apiRateLimitMax ?? Number(process.env.API_RATE_LIMIT_PER_MIN ?? 180),
    keyPrefix: 'api',
  });

  const ingestLimiter = createRateLimiter({
    windowMs: 60_000,
    maxRequests:
      deps.ingestRateLimitMax ?? Number(process.env.INGEST_RATE_LIMIT_PER_MIN ?? 240),
    keyPrefix: 'ingest',
  });

  app.use(requestContextMiddleware);
  app.use(securityHeadersMiddleware);
  app.use(corsMiddleware);
  app.use(express.json({ limit: '256kb' }));

  // Liveness probe (process health only, zero external dependency calls)
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'chiller-plant-twin',
      uptimeSec: metrics.snapshot().uptimeSec,
    });
  });

  // Readiness probe (verifies database pool & Firebase Admin app initialization)
  app.get('/api/ready', async (_req: Request, res: Response) => {
    const readiness = await checkReadiness();
    res.status(readiness.ready ? 200 : 503).json({
      status: readiness.ready ? 'ready' : 'not_ready',
      checks: readiness.checks,
    });
  });

  // OpenAPI 3.1 specification endpoint
  app.get('/api/docs/openapi.json', (_req: Request, res: Response) => {
    res.json(openApiSpec);
  });

  // Protected operational metrics endpoint
  app.get('/api/metrics', (req: AuthRequest, res: Response, next: NextFunction) => {
    const metricsToken = process.env.METRICS_TOKEN;
    const provided = req.header('x-metrics-token');
    if (metricsToken && provided && safeTokenMatch(provided, metricsToken)) {
      res.json(metrics.snapshot());
      return;
    }
    operatorAuth(req, res, () => {
      res.json(metrics.snapshot());
    });
  });

  // Hydrate full plant snapshot (KPIs, 19 devices, alarms, initial trends)
  app.get(
    '/api/v1/plants/:plantCode/snapshot',
    apiLimiter,
    operatorAuth,
    plantRole('VIEWER'),
    async (req: AuthRequest, res: Response, next: NextFunction) => {
      try {
        const plant = req.authorizedPlant!;
        const snapshot = await repo.getPlantSnapshot(
          plant.id,
          plant.code,
          req.plantRole ?? 'VIEWER',
        );
        res.json(snapshot);
      } catch (error) {
        next(error);
      }
    },
  );

  // Server-Sent Events (SSE) live stream scoped to authorized plant
  app.get(
    '/api/v1/plants/:plantCode/stream',
    operatorAuth,
    plantRole('VIEWER'),
    (req: AuthRequest, res: Response) => {
      const plant = req.authorizedPlant!;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      activeSseResponses.add(res);
      metrics.incSseClients(1);

      res.write(
        `event: connected\ndata: ${JSON.stringify({
          plantCode: plant.code,
          serverTime: new Date().toISOString(),
        })}\n\n`,
      );

      const unsubscribe = subscribeStream(plant.id, (event) => {
        if (res.writableEnded) return;
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      const keepAliveTimer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(`: ping ${Date.now()}\n\n`);
        }
      }, 15_000);
      keepAliveTimer.unref?.();

      const cleanup = () => {
        clearInterval(keepAliveTimer);
        unsubscribe();
        if (activeSseResponses.delete(res)) {
          metrics.incSseClients(-1);
        }
      };

      req.on('close', cleanup);
      res.on('close', cleanup);
    },
  );

  // Query plant-isolated historical trends for a specific device
  app.get(
    '/api/v1/plants/:plantCode/devices/:deviceId/trends',
    apiLimiter,
    operatorAuth,
    plantRole('VIEWER'),
    async (req: AuthRequest, res: Response, next: NextFunction) => {
      const parsedDevice = deviceIdSchema.safeParse(req.params.deviceId);
      if (!parsedDevice.success) {
        formatError(res, req, 400, 'INVALID_DEVICE_ID', 'Invalid deviceId parameter');
        return;
      }

      const rawLimit = Number(req.query.limit ?? 300);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(10, Math.min(300, Math.round(rawLimit)))
        : 300;

      try {
        const result = await repo.getDeviceTrends(
          req.authorizedPlant!.id,
          parsedDevice.data,
          limit,
        );
        res.json({
          plantCode: req.authorizedPlant!.code,
          deviceId: result.deviceId,
          window: '5m',
          step: '1s',
          points: result.points,
        });
      } catch (error) {
        next(error);
      }
    },
  );

  // List plant alarms
  app.get(
    '/api/v1/plants/:plantCode/alarms',
    apiLimiter,
    operatorAuth,
    plantRole('VIEWER'),
    async (req: AuthRequest, res: Response, next: NextFunction) => {
      try {
        const alarms = await repo.getPlantAlarms(req.authorizedPlant!.id);
        res.json({ plantCode: req.authorizedPlant!.code, alarms });
      } catch (error) {
        next(error);
      }
    },
  );

  // Acknowledge alarm (OPERATOR+)
  app.post(
    '/api/v1/plants/:plantCode/alarms/:alarmId/acknowledge',
    apiLimiter,
    operatorAuth,
    plantRole('OPERATOR'),
    async (req: AuthRequest, res: Response, next: NextFunction) => {
      const alarmNumericId = Number(req.params.alarmId);
      if (!Number.isInteger(alarmNumericId) || alarmNumericId <= 0) {
        formatError(res, req, 400, 'INVALID_ALARM_ID', 'Invalid alarmId parameter');
        return;
      }

      try {
        const actor = req.user?.email || req.user?.uid || 'operator';
        const alarm = await repo.acknowledgeAlarm(
          req.authorizedPlant!.id,
          alarmNumericId,
          actor,
        );
        res.json({ ok: true, alarm });
      } catch (error) {
        next(error);
      }
    },
  );

  // Clear alarm (OPERATOR+)
  app.post(
    '/api/v1/plants/:plantCode/alarms/:alarmId/clear',
    apiLimiter,
    operatorAuth,
    plantRole('OPERATOR'),
    async (req: AuthRequest, res: Response, next: NextFunction) => {
      const alarmNumericId = Number(req.params.alarmId);
      if (!Number.isInteger(alarmNumericId) || alarmNumericId <= 0) {
        formatError(res, req, 400, 'INVALID_ALARM_ID', 'Invalid alarmId parameter');
        return;
      }

      try {
        const actor = req.user?.email || req.user?.uid || 'operator';
        const alarm = await repo.clearAlarm(
          req.authorizedPlant!.id,
          alarmNumericId,
          actor,
        );
        res.json({ ok: true, alarm });
      } catch (error) {
        next(error);
      }
    },
  );

  // List edge credentials metadata (ADMIN)
  app.get(
    '/api/v1/plants/:plantCode/edge-credentials',
    apiLimiter,
    operatorAuth,
    plantRole('ADMIN'),
    async (req: AuthRequest, res: Response, next: NextFunction) => {
      try {
        const credentials = await repo.listEdgeCredentials(req.authorizedPlant!.id);
        res.json({ plantCode: req.authorizedPlant!.code, credentials });
      } catch (error) {
        next(error);
      }
    },
  );

  // Issue or rotate edge gateway credential (ADMIN)
  app.post(
    '/api/v1/plants/:plantCode/edge-credentials',
    apiLimiter,
    operatorAuth,
    plantRole('ADMIN'),
    async (req: AuthRequest, res: Response, next: NextFunction) => {
      const parsed = edgeCredentialCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        formatError(
          res,
          req,
          400,
          'VALIDATION_ERROR',
          'Invalid edge credential request',
          parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        );
        return;
      }

      try {
        const issued = await repo.createOrRotateEdgeCredential(
          req.authorizedPlant!.id,
          parsed.data.edgeDeviceId,
          parsed.data.label,
          parsed.data.expiresInDays,
        );
        logEvent('info', 'edge_credential_issued', {
          requestId: req.requestId,
          plantCode: req.authorizedPlant!.code,
          edgeDeviceId: parsed.data.edgeDeviceId,
          credentialId: issued.credentialId,
        });
        res.status(201).json(issued);
      } catch (error) {
        next(error);
      }
    },
  );

  // Assign or update operator role for plant (ADMIN)
  app.post(
    '/api/v1/plants/:plantCode/members',
    apiLimiter,
    operatorAuth,
    plantRole('ADMIN'),
    async (req: AuthRequest, res: Response, next: NextFunction) => {
      const parsed = memberAssignSchema.safeParse(req.body);
      if (!parsed.success) {
        formatError(
          res,
          req,
          400,
          'VALIDATION_ERROR',
          'Invalid member assignment payload',
          parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        );
        return;
      }

      try {
        const member = await repo.assignPlantMember(
          req.authorizedPlant!.id,
          parsed.data.email,
          parsed.data.role,
        );
        res.json({ ok: true, member });
      } catch (error) {
        next(error);
      }
    },
  );

  // Dedicated Edge Gateway Telemetry Ingestion Endpoint
  app.post(
    '/api/v1/telemetry/ingest',
    ingestLimiter,
    edgeAuth,
    async (req: AuthRequest, res: Response, next: NextFunction) => {
      const started = process.hrtime.bigint();
      const parsed = telemetryIngestSchema.safeParse(req.body);
      if (!parsed.success) {
        const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        metrics.recordIngestError(Number(latencyMs.toFixed(2)));
        formatError(
          res,
          req,
          400,
          'INVALID_TELEMETRY_PAYLOAD',
          'Telemetry payload failed schema validation',
          parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        );
        return;
      }

      const headerIdempotency = req.header('idempotency-key')?.trim();
      const idempotencyKey =
        headerIdempotency ||
        parsed.data.batchId ||
        `${parsed.data.edgeDeviceId}:${parsed.data.sequenceNumber}:${parsed.data.observedAt}`;

      if (idempotencyKey.length < 4 || idempotencyKey.length > 128) {
        formatError(
          res,
          req,
          400,
          'INVALID_IDEMPOTENCY_KEY',
          'Idempotency-Key must be between 4 and 128 characters',
        );
        return;
      }

      try {
        const result = await repo.ingestTelemetryBatch(
          req.authorizedPlant!.id,
          idempotencyKey,
          parsed.data,
        );
        const latencyMs = Number(
          (Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(2),
        );
        metrics.recordIngestSuccess(
          result.ingestedDevices,
          latencyMs,
          result.deduplicated,
        );
        logEvent('info', 'telemetry_ingested', {
          requestId: req.requestId,
          plantCode: parsed.data.plantCode,
          edgeDeviceId: parsed.data.edgeDeviceId,
          credentialId: req.edgeCredential?.credentialId,
          sequenceNumber: parsed.data.sequenceNumber,
          sampleCount: result.ingestedDevices,
          deduplicated: result.deduplicated,
          latencyMs,
        });
        res.json(result);
      } catch (error) {
        const latencyMs = Number(
          (Number(process.hrtime.bigint() - started) / 1_000_000).toFixed(2),
        );
        metrics.recordIngestError(latencyMs);
        logEvent('error', 'telemetry_ingest_failed', {
          requestId: req.requestId,
          plantCode: parsed.data.plantCode,
          edgeDeviceId: parsed.data.edgeDeviceId,
          credentialId: req.edgeCredential?.credentialId,
          latencyMs,
        });
        next(error);
      }
    },
  );

  // Explicit 404 handler for unknown /api/* routes
  app.use('/api/*', (req: ContextualRequest, res: Response) => {
    formatError(res, req, 404, 'NOT_FOUND', 'API endpoint not found');
  });

  // Centralized error handler (never leaks raw DB/Firebase stack traces to client)
  app.use(
    (err: unknown, req: ContextualRequest, res: Response, _next: NextFunction) => {
      if (err instanceof DomainError) {
        formatError(res, req, err.statusCode, err.code, err.message);
        return;
      }

      const statusErr = err as { status?: number; type?: string; message?: string };
      if (statusErr?.type === 'entity.too.large' || statusErr?.status === 413) {
        formatError(res, req, 413, 'PAYLOAD_TOO_LARGE', 'Request payload exceeds 256kb limit');
        return;
      }
      if (statusErr?.status === 400 && statusErr instanceof SyntaxError) {
        formatError(res, req, 400, 'MALFORMED_JSON', 'Request body contains invalid JSON');
        return;
      }

      logEvent('error', 'unhandled_api_error', {
        requestId: req.requestId,
        path: req.path,
        error: err instanceof Error ? err.message : 'unknown_error',
      });
      formatError(res, req, 500, 'INTERNAL_ERROR', 'An unexpected server error occurred');
    },
  );

  const closeActiveStreams = () => {
    for (const sseRes of activeSseResponses) {
      try {
        sseRes.end();
      } catch {
        // Ignore already-closed sockets
      }
    }
    activeSseResponses.clear();
  };

  return { app, closeActiveStreams };
}
