import { EventEmitter } from 'events';
import { NextFunction, Response } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { computePayloadHash, DomainError } from '../src/db/plantRepository.ts';
import type { PlantTelemetryStreamEvent } from '../src/lib/realtimeBus.ts';
import { AuthRequest } from '../src/middleware/auth.ts';
import { AppDependencies, createApp } from '../src/server/app.ts';
import { UserRole } from '../src/types/plant.ts';

const ROLE_WEIGHT: Record<UserRole, number> = {
  VIEWER: 1,
  OPERATOR: 2,
  ADMIN: 3,
};

function createTestServer(overrides: AppDependencies = {}) {
  const seenBatches = new Map<string, { hash: string; sourceType: 'EDGE' | 'SIMULATION' }>();
  const bus = new EventEmitter();
  let lastSourceType: 'EDGE' | 'SIMULATION' = 'EDGE';
  const deviceOwnership: Record<string, string[]> = {
    CENTRAL_PLANT_01: ['ch-1', 'ch-2'],
    PLANT_BETA: ['PLANT_BETA:ch-1'],
  };

  const defaultRepo: NonNullable<AppDependencies['repo']> = {
    getPlantSnapshot: async (plantId, plantCode, role) => ({
      plant: {
        id: plantId,
        code: plantCode,
        name: `Plant ${plantCode}`,
        scenario: 'Steady State',
        role,
        observedAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        quality: 'GOOD',
        isSimulated: lastSourceType === 'SIMULATION',
        sourceType: lastSourceType,
        staleAfterSec: 15,
      },
      kpis: {
        coolingLoadMw: 9.2,
        totalPowerMw: 1.9,
        systemCop: 4.8,
        wetBulbC: 27,
        chwSupplyC: 6.9,
        chwReturnC: 11.7,
        deltaTK: 4.8,
        cwSupplyC: 31.5,
        towerApproachK: 4.5,
        chillersOn: 3,
      },
      deviceGroups: [],
      alarms: [],
      trends: [],
    }),
    getDeviceTrends: async (plantId, deviceId) => {
      const code = plantId === 1 ? 'CENTRAL_PLANT_01' : 'PLANT_BETA';
      if (!deviceOwnership[code]?.includes(deviceId)) {
        throw new DomainError(404, 'DEVICE_NOT_FOUND', 'Device not found in authorized plant');
      }
      return {
        deviceId,
        points: [
          {
            timeSec: -1,
            recordedAt: new Date().toISOString(),
            loadPct: 87.4,
            cop: 6.01,
            chwOut: 6.9,
            cwIn: 31.6,
          },
        ],
      };
    },
    getPlantAlarms: async () => [],
    acknowledgeAlarm: async (_plantId, numericId, actor) => ({
      id: `alm-${numericId}`,
      numericId,
      timestamp: '10:00:00',
      severity: 'WARN',
      state: 'ACKNOWLEDGED',
      sourceType: 'EDGE',
      message: 'High CW supply',
      source: 'Edge Gateway',
      acknowledgedBy: actor,
      acknowledgedAt: new Date().toISOString(),
    }),
    clearAlarm: async (_plantId, numericId) => ({
      id: `alm-${numericId}`,
      numericId,
      timestamp: '10:00:00',
      severity: 'WARN',
      state: 'CLEARED',
      sourceType: 'EDGE',
      message: 'High CW supply',
      source: 'Edge Gateway',
      clearedAt: new Date().toISOString(),
    }),
    ingestTelemetryBatch: async (plantId, idempotencyKey, payload, options) => {
      const sourceType = options?.sourceType ?? 'EDGE';
      const hash = computePayloadHash(payload);
      const key = `${plantId}:${payload.edgeDeviceId}:${idempotencyKey}`;
      const existing = seenBatches.get(key);
      if (existing) {
        if (existing.hash !== hash) {
          throw new DomainError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Idempotency-Key already used with a different telemetry payload',
          );
        }
        return {
          ok: true,
          deduplicated: true,
          batchId: 1,
          observedAt: payload.observedAt,
          receivedAt: new Date().toISOString(),
          ingestedDevices: 0,
          isSimulated: existing.sourceType === 'SIMULATION',
          sourceType: existing.sourceType,
        };
      }
      seenBatches.set(key, { hash, sourceType });
      lastSourceType = sourceType;
      const event: PlantTelemetryStreamEvent = {
        type: 'telemetry_tick',
        plantCode: payload.plantCode,
        observedAt: payload.observedAt,
        receivedAt: new Date().toISOString(),
        quality: payload.quality,
        isSimulated: sourceType === 'SIMULATION',
        sourceType,
        scenario: payload.scenario,
        kpis: payload.kpis,
      };
      bus.emit(`plant:${plantId}`, event);
      return {
        ok: true,
        deduplicated: false,
        batchId: 1,
        observedAt: payload.observedAt,
        receivedAt: new Date().toISOString(),
        ingestedDevices: payload.devices.length,
        isSimulated: sourceType === 'SIMULATION',
        sourceType,
      };
    },
    createOrRotateEdgeCredential: async (
      _plantId,
      edgeDeviceId,
      label,
      _expiresInDays,
      credentialType = 'EDGE',
    ) => ({
      credentialId: 'edge_test123',
      edgeDeviceId,
      credentialType,
      label,
      secret: 'cp_edge_mock_secret',
      expiresAt: null,
    }),
    listEdgeCredentials: async () => [],
    assignPlantMember: async (plantId, email, role) => ({
      userId: 42,
      email,
      plantId,
      role,
    }),
  };

  const requireOperatorAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
    const auth = req.header('authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }
    const token = auth.slice(7).trim();
    if (token === 'viewer-plant1') {
      req.dbUserId = 1;
      req.user = { uid: 'u1', email: 'viewer@plant1.local' } as AuthRequest['user'];
      req.plantRole = 'VIEWER';
    } else if (token === 'operator-plant1') {
      req.dbUserId = 2;
      req.user = { uid: 'u2', email: 'op@plant1.local' } as AuthRequest['user'];
      req.plantRole = 'OPERATOR';
    } else if (token === 'admin-plant1') {
      req.dbUserId = 3;
      req.user = { uid: 'u3', email: 'admin@plant1.local' } as AuthRequest['user'];
      req.plantRole = 'ADMIN';
    } else {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
      return;
    }
    next();
  };

  const requirePlantRole = (minRole: UserRole) => (req: AuthRequest, res: Response, next: NextFunction) => {
    const plantCode = String(req.params.plantCode || '');
    if (plantCode !== 'CENTRAL_PLANT_01') {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied for this plant' } });
      return;
    }
    const role = req.plantRole ?? 'VIEWER';
    if (ROLE_WEIGHT[role] < ROLE_WEIGHT[minRole]) {
      res.status(403).json({ error: { code: 'INSUFFICIENT_ROLE', message: `Requires ${minRole}` } });
      return;
    }
    req.authorizedPlant = { id: 1, code: 'CENTRAL_PLANT_01', name: 'Central Plant' };
    next();
  };

  const requireEdgeAuth = (req: AuthRequest, res: Response, next: NextFunction) => {
    const credId = req.header('x-edge-credential-id');
    const secret = req.header('x-edge-secret');
    const isRealEdge = credId === 'edge_plant1' && secret === 'valid-secret';
    const isSimEdge = credId === 'edge_sim1' && secret === 'sim-secret';
    if (!isRealEdge && !isSimEdge) {
      res.status(401).json({ error: { code: 'EDGE_UNAUTHORIZED', message: 'Invalid edge credentials' } });
      return;
    }
    const body = req.body as Record<string, unknown>;
    if (body?.plantCode && body.plantCode !== 'CENTRAL_PLANT_01') {
      res.status(403).json({ error: { code: 'CROSS_PLANT_DENIED', message: 'Cross-plant denied' } });
      return;
    }
    if (body?.edgeDeviceId && body.edgeDeviceId !== 'gw-central-01') {
      res.status(403).json({ error: { code: 'EDGE_DEVICE_MISMATCH', message: 'Edge mismatch' } });
      return;
    }
    req.authorizedPlant = { id: 1, code: 'CENTRAL_PLANT_01', name: 'Central Plant' };
    req.edgeCredential = {
      id: isSimEdge ? 2 : 1,
      credentialId: credId!,
      edgeDeviceId: 'gw-central-01',
      plantId: 1,
      credentialType: isSimEdge ? 'SIMULATION' : 'EDGE',
    };
    next();
  };

  const { app, closeActiveStreams } = createApp({
    checkReadiness: async () => ({
      ready: true,
      checks: { database: 'ok', auth: 'ok' },
    }),
    requireOperatorAuth,
    requirePlantRole,
    requireEdgeAuth,
    repo: defaultRepo,
    subscribePlantStream: (plantId, listener) => {
      const ch = `plant:${plantId}`;
      bus.on(ch, listener);
      return () => {
        bus.off(ch, listener);
      };
    },
    ...overrides,
  });

  const server = http.createServer(app);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => {
          closeActiveStreams();
          return new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
  });
}

describe('Express API integration & authorization tests', () => {
  let closeServer: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (closeServer) {
      await closeServer();
      closeServer = null;
    }
  });

  it('serves separate /api/health, /api/ready (200 & 503), and /api/docs/openapi.json', async () => {
    const srv = await createTestServer();
    closeServer = srv.close;

    const health = await fetch(`${srv.baseUrl}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');

    const ready = await fetch(`${srv.baseUrl}/api/ready`);
    expect(ready.status).toBe(200);

    const spec = await fetch(`${srv.baseUrl}/api/docs/openapi.json`);
    expect(spec.status).toBe(200);
    const specJson = (await spec.json()) as { openapi: string };
    expect(specJson.openapi).toBe('3.1.0');

    await srv.close();
    closeServer = null;

    const degraded = await createTestServer({
      checkReadiness: async () => ({
        ready: false,
        checks: { database: 'unavailable', auth: 'ok' },
      }),
    });
    closeServer = degraded.close;
    const ready503 = await fetch(`${degraded.baseUrl}/api/ready`);
    expect(ready503.status).toBe(503);
  });

  it('enforces operator auth, RBAC, and cross-plant isolation on snapshot, trends, alarms, and edge credentials', async () => {
    const srv = await createTestServer();
    closeServer = srv.close;

    const noAuth = await fetch(`${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/snapshot`);
    expect(noAuth.status).toBe(401);

    const crossPlant = await fetch(`${srv.baseUrl}/api/v1/plants/PLANT_BETA/snapshot`, {
      headers: { Authorization: 'Bearer viewer-plant1' },
    });
    expect(crossPlant.status).toBe(403);

    const okSnap = await fetch(`${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/snapshot`, {
      headers: { Authorization: 'Bearer viewer-plant1' },
    });
    expect(okSnap.status).toBe(200);

    const alienDeviceTrend = await fetch(
      `${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/devices/PLANT_BETA:ch-1/trends`,
      { headers: { Authorization: 'Bearer viewer-plant1' } },
    );
    expect(alienDeviceTrend.status).toBe(404);

    const viewerAck = await fetch(
      `${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/alarms/10/acknowledge`,
      { method: 'POST', headers: { Authorization: 'Bearer viewer-plant1' } },
    );
    expect(viewerAck.status).toBe(403);

    const operatorAck = await fetch(
      `${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/alarms/10/acknowledge`,
      { method: 'POST', headers: { Authorization: 'Bearer operator-plant1' } },
    );
    expect(operatorAck.status).toBe(200);

    const operatorIssueCred = await fetch(
      `${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/edge-credentials`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer operator-plant1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ edgeDeviceId: 'gw-central-01', label: 'GW' }),
      },
    );
    expect(operatorIssueCred.status).toBe(403);

    const adminIssueCred = await fetch(
      `${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/edge-credentials`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-plant1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ edgeDeviceId: 'gw-central-01', label: 'GW' }),
      },
    );
    expect(adminIssueCred.status).toBe(201);
  });

  it('validates edge auth, cross-plant ingest rejection, schema 400, and idempotent duplicate handling', async () => {
    const srv = await createTestServer();
    closeServer = srv.close;

    const validBody = {
      plantCode: 'CENTRAL_PLANT_01',
      edgeDeviceId: 'gw-central-01',
      sequenceNumber: 1,
      payloadVersion: '1.0.0',
      observedAt: new Date(Date.now() - 1000).toISOString(),
      scenario: 'Steady State',
      quality: 'GOOD',
      kpis: {
        coolingLoadMw: 9.2,
        totalPowerMw: 1.9,
        systemCop: 4.8,
        wetBulbC: 27,
        chwSupplyC: 6.9,
        chwReturnC: 11.7,
        deltaTK: 4.8,
        cwSupplyC: 31.5,
        towerApproachK: 4.5,
        chillersOn: 3,
      },
      devices: [
        { id: 'ch-1', status: 'RUNNING', loadPct: 88, metrics: { Load: 88, COP: 6.0 } },
      ],
    };

    // Operator token cannot ingest telemetry directly without edge credentials
    const operatorAttempt = await fetch(`${srv.baseUrl}/api/v1/telemetry/ingest`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-plant1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(validBody),
    });
    expect(operatorAttempt.status).toBe(401);

    // Cross-plant ingest attempt by edge credential is rejected with 403
    const crossPlantAttempt = await fetch(`${srv.baseUrl}/api/v1/telemetry/ingest`, {
      method: 'POST',
      headers: {
        'X-Edge-Credential-Id': 'edge_plant1',
        'X-Edge-Secret': 'valid-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...validBody, plantCode: 'PLANT_BETA' }),
    });
    expect(crossPlantAttempt.status).toBe(403);

    // Invalid payload schema returns 400
    const badPayload = await fetch(`${srv.baseUrl}/api/v1/telemetry/ingest`, {
      method: 'POST',
      headers: {
        'X-Edge-Credential-Id': 'edge_plant1',
        'X-Edge-Secret': 'valid-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...validBody, devices: [] }),
    });
    expect(badPayload.status).toBe(400);

    // First ingest succeeds and second retry with same Idempotency-Key deduplicates cleanly
    const headers = {
      'X-Edge-Credential-Id': 'edge_plant1',
      'X-Edge-Secret': 'valid-secret',
      'Idempotency-Key': 'batch-retry-key-1',
      'Content-Type': 'application/json',
    };
    const first = await fetch(`${srv.baseUrl}/api/v1/telemetry/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBody),
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { deduplicated: boolean; ingestedDevices: number };
    expect(firstJson.deduplicated).toBe(false);
    expect(firstJson.ingestedDevices).toBe(1);

    const retry = await fetch(`${srv.baseUrl}/api/v1/telemetry/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify(validBody),
    });
    expect(retry.status).toBe(200);
    const retryJson = (await retry.json()) as { deduplicated: boolean; ingestedDevices: number };
    expect(retryJson.deduplicated).toBe(true);
    expect(retryJson.ingestedDevices).toBe(0);

    // Reusing the same Idempotency-Key with a DIFFERENT payload returns 409 IDEMPOTENCY_CONFLICT
    const conflict = await fetch(`${srv.baseUrl}/api/v1/telemetry/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...validBody,
        kpis: { ...validBody.kpis, coolingLoadMw: 15.0 },
      }),
    });
    expect(conflict.status).toBe(409);
    const conflictJson = (await conflict.json()) as { error: { code: string } };
    expect(conflictJson.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('stamps SIMULATION credential provenance onto snapshot and SSE ticks and enforces SSE authz', async () => {
    const srv = await createTestServer();
    closeServer = srv.close;

    // Cross-plant SSE rejected
    const forbiddenSse = await fetch(`${srv.baseUrl}/api/v1/plants/PLANT_BETA/stream`, {
      headers: { Authorization: 'Bearer viewer-plant1' },
    });
    expect(forbiddenSse.status).toBe(403);

    // Open authorized SSE stream
    const streamController = new AbortController();
    const sseRes = await fetch(`${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/stream`, {
      headers: { Authorization: 'Bearer viewer-plant1', Accept: 'text/event-stream' },
      signal: streamController.signal,
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    const firstChunk = await reader.read();
    const connectedText = decoder.decode(firstChunk.value);
    expect(connectedText).toContain('event: connected');

    // Ingest using SIMULATION credential
    const simIngest = await fetch(`${srv.baseUrl}/api/v1/telemetry/ingest`, {
      method: 'POST',
      headers: {
        'X-Edge-Credential-Id': 'edge_sim1',
        'X-Edge-Secret': 'sim-secret',
        'Idempotency-Key': 'sim-sse-batch-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        plantCode: 'CENTRAL_PLANT_01',
        edgeDeviceId: 'gw-central-01',
        sequenceNumber: 2,
        payloadVersion: '1.0.0',
        observedAt: new Date(Date.now() - 500).toISOString(),
        scenario: 'Peak Cooling',
        quality: 'GOOD',
        kpis: {
          coolingLoadMw: 10.3,
          totalPowerMw: 2.3,
          systemCop: 4.48,
          wetBulbC: 28.4,
          chwSupplyC: 7.0,
          chwReturnC: 12.6,
          deltaTK: 5.6,
          cwSupplyC: 32.8,
          towerApproachK: 4.4,
          chillersOn: 3,
        },
        devices: [{ id: 'ch-1', status: 'RUNNING', loadPct: 95, metrics: { Load: 95 } }],
      }),
    });
    expect(simIngest.status).toBe(200);
    const simJson = (await simIngest.json()) as { isSimulated: boolean; sourceType: string };
    expect(simJson.isSimulated).toBe(true);
    expect(simJson.sourceType).toBe('SIMULATION');

    const tickChunk = await reader.read();
    const tickText = decoder.decode(tickChunk.value);
    expect(tickText).toContain('event: telemetry_tick');
    expect(tickText).toContain('"isSimulated":true');
    expect(tickText).toContain('"sourceType":"SIMULATION"');

    streamController.abort();

    // Snapshot also reflects SIMULATION provenance
    const snap = await fetch(`${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/snapshot`, {
      headers: { Authorization: 'Bearer viewer-plant1' },
    });
    const snapJson = (await snap.json()) as { plant: { isSimulated: boolean; sourceType: string } };
    expect(snapJson.plant.isSimulated).toBe(true);
    expect(snapJson.plant.sourceType).toBe('SIMULATION');
  });

  it('returns uniform sanitized 404 and 500 JSON responses without leaking internal details', async () => {
    const srv = await createTestServer({
      repo: {
        getPlantSnapshot: async () => {
          throw new Error('ECONNREFUSED postgres://secret@10.0.0.5:5432/prod');
        },
        getDeviceTrends: async () => ({ deviceId: 'ch-1', points: [] }),
        getPlantAlarms: async () => [],
        acknowledgeAlarm: async () => {
          throw new Error('db fail');
        },
        clearAlarm: async () => {
          throw new Error('db fail');
        },
        ingestTelemetryBatch: async () => {
          throw new Error('db fail');
        },
        createOrRotateEdgeCredential: async () => {
          throw new Error('db fail');
        },
        listEdgeCredentials: async () => [],
        assignPlantMember: async () => {
          throw new Error('db fail');
        },
      },
    });
    closeServer = srv.close;

    const notFound = await fetch(`${srv.baseUrl}/api/v1/unknown-route`);
    expect(notFound.status).toBe(404);
    const notFoundJson = (await notFound.json()) as { error: { code: string } };
    expect(notFoundJson.error.code).toBe('NOT_FOUND');

    const internalErr = await fetch(`${srv.baseUrl}/api/v1/plants/CENTRAL_PLANT_01/snapshot`, {
      headers: { Authorization: 'Bearer viewer-plant1' },
    });
    expect(internalErr.status).toBe(500);
    const errText = await internalErr.text();
    expect(errText).not.toContain('ECONNREFUSED');
    expect(errText).not.toContain('10.0.0.5');
    expect(errText).not.toContain('postgres://');
  });
});
