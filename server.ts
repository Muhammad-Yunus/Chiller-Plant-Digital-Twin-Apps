import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getDeviceTrends,
  getPlantSnapshot,
  ingestTelemetry,
} from './src/db/plantRepository.ts';
import { AuthRequest, requireAuth } from './src/middleware/auth.ts';
import { DeviceStatus, PlantKpis, ScenarioId } from './src/types/plant.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VALID_SCENARIOS = new Set<ScenarioId>([
  'Steady State',
  'Peak Cooling',
  'Part Load',
  'High Wet Bulb',
]);

const VALID_STATUSES = new Set<DeviceStatus>(['RUNNING', 'STANDBY', 'ISOLATED']);
const PLANT_CODE_REGEX = /^[A-Z0-9_-]{3,32}$/;
const DEVICE_ID_REGEX = /^[a-z0-9-]{2,32}$/;

function isFiniteNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

function validateKpis(raw: unknown): raw is PlantKpis {
  if (!raw || typeof raw !== 'object') return false;
  const k = raw as Record<string, unknown>;
  return (
    isFiniteNumber(k.coolingLoadMw) &&
    isFiniteNumber(k.totalPowerMw) &&
    isFiniteNumber(k.systemCop) &&
    isFiniteNumber(k.wetBulbC) &&
    isFiniteNumber(k.chwSupplyC) &&
    isFiniteNumber(k.chwReturnC) &&
    isFiniteNumber(k.deltaTK) &&
    isFiniteNumber(k.cwSupplyC) &&
    isFiniteNumber(k.towerApproachK) &&
    isFiniteNumber(k.chillersOn)
  );
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Lightweight liveness check (does not eagerly probe DB at startup)
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Protected Plant Snapshot Hydration
  app.get(
    '/api/v1/plants/:plantCode/snapshot',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      const plantCode = String(req.params.plantCode || '');
      if (!PLANT_CODE_REGEX.test(plantCode)) {
        res.status(400).json({ error: 'Invalid plantCode parameter' });
        return;
      }

      try {
        const snapshot = await getPlantSnapshot(plantCode);
        res.json(snapshot);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Failed to load plant snapshot';
        res.status(500).json({ error: msg });
      }
    },
  );

  // Protected Device Trend Series Query
  app.get(
    '/api/v1/plants/:plantCode/devices/:deviceId/trends',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      const plantCode = String(req.params.plantCode || '');
      const deviceId = String(req.params.deviceId || '');
      if (!PLANT_CODE_REGEX.test(plantCode) || !DEVICE_ID_REGEX.test(deviceId)) {
        res.status(400).json({ error: 'Invalid plantCode or deviceId' });
        return;
      }

      const rawLimit = Number(req.query.limit ?? 300);
      const limit = Number.isFinite(rawLimit)
        ? Math.max(10, Math.min(300, Math.round(rawLimit)))
        : 300;

      try {
        const points = await getDeviceTrends(deviceId, limit);
        res.json({ deviceId, window: '5m', step: '1s', points });
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Failed to load trend history';
        res.status(500).json({ error: msg });
      }
    },
  );

  // Protected Telemetry Ingestion & Scenario Update Endpoint
  app.post(
    '/api/v1/telemetry/ingest',
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      const body = req.body as Record<string, unknown> | undefined;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Invalid JSON body' });
        return;
      }

      const plantCode = String(body.plantCode ?? '');
      const scenario = String(body.scenario ?? 'Steady State') as ScenarioId;

      if (!PLANT_CODE_REGEX.test(plantCode)) {
        res.status(400).json({ error: 'Invalid plantCode' });
        return;
      }
      if (!VALID_SCENARIOS.has(scenario)) {
        res.status(400).json({ error: 'Invalid scenario value' });
        return;
      }
      if (!validateKpis(body.kpis)) {
        res.status(400).json({ error: 'Invalid KPI payload' });
        return;
      }

      const rawDevices = Array.isArray(body.devices) ? body.devices : [];
      if (rawDevices.length > 50) {
        res.status(400).json({ error: 'Too many device entries in single batch' });
        return;
      }

      const parsedDevices = [];
      for (const item of rawDevices) {
        if (!item || typeof item !== 'object') continue;
        const d = item as Record<string, unknown>;
        const id = String(d.id ?? '');
        const status = String(d.status ?? 'RUNNING') as DeviceStatus;
        const loadPct = Number(d.loadPct);
        if (
          !DEVICE_ID_REGEX.test(id) ||
          !VALID_STATUSES.has(status) ||
          !Number.isFinite(loadPct) ||
          loadPct < 0 ||
          loadPct > 120
        ) {
          res.status(400).json({ error: `Invalid device payload for ${id}` });
          return;
        }
        const metrics: Record<string, string | number> = {};
        if (d.metrics && typeof d.metrics === 'object') {
          for (const [k, v] of Object.entries(d.metrics as Record<string, unknown>)) {
            if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
              metrics[k.slice(0, 40)] = typeof v === 'string' ? v.slice(0, 64) : v;
            }
          }
        }
        parsedDevices.push({ id, status, loadPct, metrics });
      }

      let newAlarm:
        | {
            severity: 'INFO' | 'WARN' | 'CRIT';
            message: string;
            source: string;
          }
        | undefined;
      if (body.newAlarm && typeof body.newAlarm === 'object') {
        const alm = body.newAlarm as Record<string, unknown>;
        const sev = String(alm.severity ?? 'INFO');
        if (sev === 'INFO' || sev === 'WARN' || sev === 'CRIT') {
          newAlarm = {
            severity: sev,
            message: String(alm.message ?? '').slice(0, 240),
            source: String(alm.source ?? 'Control Panel').slice(0, 80),
          };
        }
      }

      try {
        const result = await ingestTelemetry({
          plantCode,
          scenario,
          kpis: body.kpis,
          devices: parsedDevices,
          newAlarm,
        });
        res.json(result);
      } catch (error: unknown) {
        const msg =
          error instanceof Error ? error.message : 'Telemetry ingestion failed';
        res.status(500).json({ error: msg });
      }
    },
  );

  // Vite dev middleware or static dist serving
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Chiller Plant Twin server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start Express server:', err);
  process.exit(1);
});
