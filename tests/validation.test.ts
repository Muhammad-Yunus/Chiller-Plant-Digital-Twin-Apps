import { describe, expect, it } from 'vitest';
import { buildSimulatedTelemetryBatch, type SimulatorMode } from '../src/scripts/edgeSimulator.ts';
import {
  edgeCredentialCreateSchema,
  memberAssignSchema,
  telemetryIngestSchema,
} from '../src/validation/telemetrySchemas.ts';

function buildValidPayload(overrides: Record<string, unknown> = {}) {
  return {
    plantCode: 'CENTRAL_PLANT_01',
    edgeDeviceId: 'gw-central-01',
    batchId: 'batch-0001',
    sequenceNumber: 101,
    payloadVersion: '1.0.0',
    observedAt: new Date(Date.now() - 2000).toISOString(),
    scenario: 'Steady State',
    quality: 'GOOD',
    kpis: {
      coolingLoadMw: 9.22,
      totalPowerMw: 1.94,
      systemCop: 4.75,
      wetBulbC: 27.0,
      chwSupplyC: 6.9,
      chwReturnC: 11.7,
      deltaTK: 4.8,
      cwSupplyC: 31.5,
      towerApproachK: 4.5,
      chillersOn: 3,
    },
    devices: [
      {
        id: 'ch-1',
        status: 'RUNNING',
        quality: 'GOOD',
        loadPct: 87.4,
        runHours: 42592,
        metrics: {
          Load: 87.4,
          Capacity: 3072,
          Power: 511.5,
          COP: 6.01,
          'CHW Out': 6.9,
          'CW In': 31.6,
        },
      },
    ],
    ...overrides,
  };
}

describe('telemetryIngestSchema validation', () => {
  it('accepts a valid telemetry batch payload', () => {
    const result = telemetryIngestSchema.safeParse(buildValidPayload());
    expect(result.success).toBe(true);
  });

  it('rejects missing provenance fields (edgeDeviceId, sequenceNumber, payloadVersion)', () => {
    const payload = buildValidPayload();
    delete (payload as Record<string, unknown>).edgeDeviceId;
    delete (payload as Record<string, unknown>).sequenceNumber;
    delete (payload as Record<string, unknown>).payloadVersion;
    const result = telemetryIngestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  it('rejects out-of-range device loadPct > 120 or negative KPIs', () => {
    const res1 = telemetryIngestSchema.safeParse(
      buildValidPayload({
        devices: [{ id: 'ch-1', status: 'RUNNING', loadPct: 145, metrics: {} }],
      }),
    );
    expect(res1.success).toBe(false);

    const base = buildValidPayload();
    const res2 = telemetryIngestSchema.safeParse(
      buildValidPayload({
        kpis: { ...base.kpis, coolingLoadMw: -1.5 },
      }),
    );
    expect(res2.success).toBe(false);
  });

  it('rejects observedAt timestamps more than 5 minutes in the future', () => {
    const futureIso = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const res = telemetryIngestSchema.safeParse(
      buildValidPayload({ observedAt: futureIso }),
    );
    expect(res.success).toBe(false);
  });

  it('rejects unexpected top-level properties due to strict schema', () => {
    const res = telemetryIngestSchema.safeParse(
      buildValidPayload({ unexpectedAdminOverride: true }),
    );
    expect(res.success).toBe(false);
  });

  it('validates edge credential and member assignment schemas', () => {
    expect(
      edgeCredentialCreateSchema.safeParse({
        edgeDeviceId: 'gw-central-01',
        label: 'Primary Plant PLC Gateway',
        expiresInDays: 90,
      }).success,
    ).toBe(true);

    expect(
      edgeCredentialCreateSchema.safeParse({
        edgeDeviceId: 'gw-sim-01',
        label: 'Edge Simulator',
        credentialType: 'SIMULATION',
      }).success,
    ).toBe(true);

    expect(
      memberAssignSchema.safeParse({
        email: 'operator@example.com',
        role: 'OPERATOR',
      }).success,
    ).toBe(true);

    expect(
      memberAssignSchema.safeParse({
        email: 'not-an-email',
        role: 'SUPERADMIN',
      }).success,
    ).toBe(false);
  });

  it('builds deterministic schema-valid 19-device simulator payloads across all 4 modes', () => {
    const fixedTime = new Date('2026-11-21T12:00:00.000Z');
    const modes: SimulatorMode[] = ['steady', 'peak', 'part-load', 'high-wet-bulb'];
    for (const mode of modes) {
      const batch = buildSimulatedTelemetryBatch({
        plantCode: 'CENTRAL_PLANT_01',
        edgeDeviceId: 'gw-sim-01',
        sequenceNumber: Math.floor(Date.now() / 1000),
        mode,
        seed: 1337,
        observedAt: fixedTime,
      });
      expect(batch.devices).toHaveLength(19);
      const parsed = telemetryIngestSchema.safeParse(batch);
      expect(parsed.success).toBe(true);
    }

    const a = buildSimulatedTelemetryBatch({
      plantCode: 'CENTRAL_PLANT_01',
      edgeDeviceId: 'gw-sim-01',
      sequenceNumber: 10,
      mode: 'peak',
      seed: 99,
      observedAt: fixedTime,
    });
    const b = buildSimulatedTelemetryBatch({
      plantCode: 'CENTRAL_PLANT_01',
      edgeDeviceId: 'gw-sim-01',
      sequenceNumber: 10,
      mode: 'peak',
      seed: 99,
      observedAt: fixedTime,
    });
    expect(a).toEqual(b);
  });
});
