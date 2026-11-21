import crypto from 'crypto';
import dotenv from 'dotenv';
import { pathToFileURL } from 'url';
import { createInitialDeviceGroups, SCENARIO_TARGETS } from '../data/plantData.ts';
import type { ScenarioId } from '../types/plant.ts';
import type { TelemetryIngestPayload } from '../validation/telemetrySchemas.ts';

dotenv.config({ override: true });

export type SimulatorMode = 'steady' | 'peak' | 'part-load' | 'high-wet-bulb';

const MODE_TO_SCENARIO: Record<SimulatorMode, ScenarioId> = {
  steady: 'Steady State',
  peak: 'Peak Cooling',
  'part-load': 'Part Load',
  'high-wet-bulb': 'High Wet Bulb',
};

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSimulatedTelemetryBatch(options: {
  plantCode: string;
  edgeDeviceId: string;
  sequenceNumber: number;
  mode: SimulatorMode;
  seed: number;
  observedAt?: Date;
  batchId?: string;
}): TelemetryIngestPayload {
  const scenario = MODE_TO_SCENARIO[options.mode];
  const target = SCENARIO_TARGETS[scenario];
  const rand = mulberry32(options.seed + options.sequenceNumber * 997);
  const jitter = (amp: number) => (rand() - 0.5) * 2 * amp;

  const coolingLoadMw = Number(Math.max(0.5, target.coolingLoadMw + jitter(0.18)).toFixed(2));
  const systemCop = Number(Math.max(2.5, target.cop * 0.79 + jitter(0.08)).toFixed(2));
  const totalPowerMw = Number((coolingLoadMw / systemCop).toFixed(2));
  const wetBulbC = Number((target.wetBulbC + jitter(0.15)).toFixed(1));
  const chwSupplyC = Number((target.chwSupplyC + jitter(0.08)).toFixed(1));
  const chwReturnC = Number((target.chwReturnC + jitter(0.12)).toFixed(1));
  const deltaTK = Number(Math.max(0.5, chwReturnC - chwSupplyC).toFixed(1));
  const cwSupplyC = Number((target.cwSupplyC + jitter(0.14)).toFixed(1));
  const towerApproachK = Number(Math.max(1.0, cwSupplyC - wetBulbC).toFixed(2));
  const observedAt = (options.observedAt ?? new Date()).toISOString();

  const templateGroups = createInitialDeviceGroups();
  const devices: TelemetryIngestPayload['devices'] = [];

  for (const group of templateGroups) {
    group.devices.forEach((dev, idx) => {
      if (group.category === 'Chiller') {
        const running = idx < target.chillersOn;
        const loadPct = running
          ? Number(Math.min(105, Math.max(25, target.chillerLoadPct + jitter(1.6))).toFixed(1))
          : 0;
        const capKw = Math.round((loadPct / 100) * 3517);
        const cop = running ? Number(Math.max(3.5, target.cop + jitter(0.08)).toFixed(2)) : 0;
        const powerKw = running ? Number((capKw / cop).toFixed(1)) : 0;
        devices.push({
          id: dev.id,
          status: running ? 'RUNNING' : 'STANDBY',
          quality: 'GOOD',
          loadPct,
          runHours: 42592 - idx * 418 + (Math.floor(options.sequenceNumber / 3600) % 5000),
          metrics: {
            Load: loadPct,
            Capacity: capKw,
            Power: powerKw,
            COP: cop,
            'CHW Out': chwSupplyC,
            'CHW In': chwReturnC,
            'CW In': cwSupplyC,
            'CW Out': Number((cwSupplyC + (running ? 4.6 : 0)).toFixed(1)),
          },
        });
        return;
      }

      if (group.category === 'CHW Pump' || group.category === 'CW Pump') {
        const running = idx < target.chillersOn;
        const speed = running
          ? Number(Math.min(100, Math.max(35, target.pumpLoadPct + jitter(1.2))).toFixed(1))
          : 0;
        const flowRate = running
          ? Math.round((speed / 100) * (group.category === 'CHW Pump' ? 605 : 726))
          : 0;
        const powerKw = running
          ? Number(((speed / 100) ** 3 * (group.category === 'CHW Pump' ? 75 : 90)).toFixed(1))
          : 0;
        devices.push({
          id: dev.id,
          status: running ? 'RUNNING' : 'STANDBY',
          quality: 'GOOD',
          loadPct: speed,
          metrics: {
            Speed: speed,
            'Flow Rate': flowRate,
            Power: powerKw,
            'Motor Freq': Number(((speed / 100) * 50).toFixed(1)),
          },
        });
        return;
      }

      if (group.category === 'Cooling Tower') {
        const fanSpeed = Number(Math.min(100, Math.max(40, target.pumpLoadPct - 2 + jitter(1.5))).toFixed(1));
        const heatReject = Math.round((coolingLoadMw * 1000 + totalPowerMw * 1000) / 2);
        devices.push({
          id: dev.id,
          status: 'RUNNING',
          quality: 'GOOD',
          loadPct: fanSpeed,
          metrics: {
            'Fan Speed': fanSpeed,
            'Heat Reject': heatReject,
            'Fan Power': Number((((fanSpeed / 100) ** 3) * 45).toFixed(1)),
            Approach: towerApproachK,
            'Basin Temp': cwSupplyC,
          },
        });
        return;
      }

      if (group.category === 'Aux Equipment') {
        devices.push({
          id: dev.id,
          status: 'RUNNING',
          quality: 'GOOD',
          loadPct: 100,
          metrics:
            dev.id === 'cp-1'
              ? {
                  'Active Stage': `Stage ${target.chillersOn}`,
                  'CHW Setpt': target.chwSupplyC,
                  'CW Setpt': cwSupplyC,
                }
              : {
                  Pressure: 442,
                  'Flow Thru': Math.round(target.chillersOn * 605),
                  'Fluid Temp': cwSupplyC,
                },
        });
        return;
      }

      const valveIdx = idx % 3;
      const open = valveIdx < target.chillersOn;
      devices.push({
        id: dev.id,
        status: open ? 'RUNNING' : 'STANDBY',
        quality: 'GOOD',
        loadPct: open ? 100 : 0,
        metrics: {
          Position: open ? 100 : 0,
          State: open ? 'OPEN' : 'CLOSED',
        },
      });
    });
  }

  const alarms: NonNullable<TelemetryIngestPayload['alarms']> = [];
  if (options.mode === 'high-wet-bulb' && towerApproachK > 3.5) {
    alarms.push({
      deviceId: 'ct-1',
      severity: 'WARN',
      message: `Elevated wet-bulb (${wetBulbC}°C) — condenser approach ${towerApproachK.toFixed(2)}K`,
      source: 'Edge Simulator',
      dedupeKey: 'sim-high-wet-bulb-approach',
    });
  } else if (options.mode === 'peak' && coolingLoadMw > 10.1) {
    alarms.push({
      deviceId: 'ch-1',
      severity: 'INFO',
      message: `Peak plant demand ${coolingLoadMw.toFixed(2)} MW (${target.chillersOn} chillers active)`,
      source: 'Edge Simulator',
      dedupeKey: 'sim-peak-demand-info',
    });
  }

  return {
    plantCode: options.plantCode,
    edgeDeviceId: options.edgeDeviceId,
    batchId: options.batchId ?? `sim-${options.edgeDeviceId}-seq-${options.sequenceNumber}`,
    sequenceNumber: options.sequenceNumber,
    payloadVersion: '1.0.0',
    observedAt,
    scenario,
    quality: 'GOOD',
    kpis: {
      coolingLoadMw,
      totalPowerMw,
      systemCop,
      wetBulbC,
      chwSupplyC,
      chwReturnC,
      deltaTK,
      cwSupplyC,
      towerApproachK,
      chillersOn: target.chillersOn,
    },
    devices,
    ...(alarms.length > 0 ? { alarms } : {}),
  };
}

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function parseMode(raw: string | undefined): SimulatorMode {
  const candidate = (raw ?? 'steady').toLowerCase();
  if (
    candidate === 'steady' ||
    candidate === 'peak' ||
    candidate === 'part-load' ||
    candidate === 'high-wet-bulb'
  ) {
    return candidate;
  }
  throw new Error(
    `Invalid mode "${candidate}". Use one of: steady, peak, part-load, high-wet-bulb`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendBatchWithRetry(options: {
  url: string;
  credentialId: string;
  secret: string;
  idempotencyKey: string;
  payload: TelemetryIngestPayload;
  maxRetries?: number;
}) {
  const maxRetries = options.maxRetries ?? 2;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetch(options.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Edge-Credential-Id': options.credentialId,
          'X-Edge-Secret': options.secret,
          'Idempotency-Key': options.idempotencyKey,
        },
        body: JSON.stringify(options.payload),
      });

      const bodyText = await res.text();
      let parsedBody: Record<string, unknown> = {};
      try {
        parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        parsedBody = { raw: bodyText };
      }

      if (res.status === 401 || res.status === 403 || res.status === 409) {
        return { status: res.status, ok: false, body: parsedBody, retryable: false };
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxRetries) {
          const waitMs = 500 * Math.pow(2, attempt);
          console.warn(
            `[edge-sim] HTTP ${res.status} on seq=${options.payload.sequenceNumber}, retrying in ${waitMs}ms with same Idempotency-Key=${options.idempotencyKey}`,
          );
          await sleep(waitMs);
          continue;
        }
        return { status: res.status, ok: false, body: parsedBody, retryable: true };
      }

      return { status: res.status, ok: res.ok, body: parsedBody, retryable: false };
    } catch (err) {
      if (attempt < maxRetries) {
        const waitMs = 500 * Math.pow(2, attempt);
        console.warn(
          `[edge-sim] Network error on seq=${options.payload.sequenceNumber}, retrying in ${waitMs}ms...`,
        );
        await sleep(waitMs);
        continue;
      }
      return {
        status: 0,
        ok: false,
        body: { error: err instanceof Error ? err.message : 'network_error' },
        retryable: true,
      };
    }
  }
  return { status: 0, ok: false, body: {}, retryable: false };
}

async function runCli() {
  const apiUrl = (getArg('--url') ?? process.env.EDGE_API_URL ?? 'http://127.0.0.1:3000')
    .replace(/\/+$/, '');
  const credentialId = getArg('--credential-id') ?? process.env.EDGE_CREDENTIAL_ID?.trim();
  const secret = getArg('--secret') ?? process.env.EDGE_SECRET?.trim();
  const plantCode = getArg('--plant') ?? process.env.PLANT_CODE?.trim() ?? 'CENTRAL_PLANT_01';
  const edgeDeviceId = getArg('--edge-id') ?? process.env.EDGE_DEVICE_ID?.trim() ?? 'gw-sim-01';
  const mode = parseMode(getArg('--mode') ?? process.env.SIM_MODE);
  const intervalMs = Math.max(200, Number(getArg('--interval-ms') ?? process.env.SIM_INTERVAL_MS ?? 2000));
  const loops = Math.max(0, Number(getArg('--loops') ?? process.env.SIM_LOOPS ?? 0));
  const seed = Number(getArg('--seed') ?? process.env.SIM_SEED ?? 1337);
  const startSeq = Number(getArg('--start-seq') ?? Math.floor(Date.now() / 1000));

  if (!credentialId || !secret) {
    throw new Error(
      'EDGE_CREDENTIAL_ID and EDGE_SECRET must be provided via environment variables or flags.',
    );
  }

  const endpoint = apiUrl.endsWith('/api/v1/telemetry/ingest')
    ? apiUrl
    : `${apiUrl}/api/v1/telemetry/ingest`;

  let stopped = false;
  process.on('SIGINT', () => {
    stopped = true;
  });
  process.on('SIGTERM', () => {
    stopped = true;
  });

  console.log(
    `[edge-sim] Starting simulator -> ${endpoint} plant=${plantCode} edge=${edgeDeviceId} mode=${mode} interval=${intervalMs}ms loops=${loops || 'infinite'} seed=${seed}`,
  );

  let iteration = 0;
  while (!stopped && (loops === 0 || iteration < loops)) {
    const seq = startSeq + iteration;
    const runNonce = crypto.randomBytes(3).toString('hex');
    const idempotencyKey = `${edgeDeviceId}-${seq}-${runNonce}`;
    const payload = buildSimulatedTelemetryBatch({
      plantCode,
      edgeDeviceId,
      sequenceNumber: seq,
      mode,
      seed,
      batchId: idempotencyKey,
    });

    const outcome = await sendBatchWithRetry({
      url: endpoint,
      credentialId,
      secret,
      idempotencyKey,
      payload,
    });

    if (outcome.ok) {
      const dedup = Boolean(outcome.body.deduplicated);
      const count = outcome.body.ingestedDevices ?? payload.devices.length;
      console.log(
        `[edge-sim] seq=${seq} HTTP ${outcome.status} devices=${count} load=${payload.kpis.coolingLoadMw}MW cop=${payload.kpis.systemCop} dedup=${dedup} source=${String(outcome.body.sourceType ?? 'SIMULATION')}`,
      );
    } else {
      console.warn(
        `[edge-sim] seq=${seq} HTTP ${outcome.status} rejected: ${JSON.stringify(outcome.body)}`,
      );
      if (outcome.status === 401 || outcome.status === 403) {
        process.exitCode = 1;
        break;
      }
    }

    iteration += 1;
    if (!stopped && (loops === 0 || iteration < loops)) {
      await sleep(intervalMs);
    }
  }

  console.log(`[edge-sim] Stopped after ${iteration} batch(es).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => {
    console.error('[edge-sim] Fatal error:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
