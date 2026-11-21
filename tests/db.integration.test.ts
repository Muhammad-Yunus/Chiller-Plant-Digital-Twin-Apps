import dotenv from 'dotenv';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInitialDeviceGroups } from '../src/data/plantData.ts';
import { closePool, db } from '../src/db/index.ts';
import {
  acknowledgeAlarm,
  clearAlarm,
  createOrRotateEdgeCredential,
  DomainError,
  getDeviceTrends,
  getPlantSnapshot,
  ingestTelemetryBatch,
  seedPlantDevelopment,
} from '../src/db/plantRepository.ts';
import {
  deviceCurrentStates,
  deviceTelemetrySamples,
  edgeCredentials,
  plantAlarms,
  plantKpiSnapshots,
  plants,
  telemetryBatches,
} from '../src/db/schema.ts';

dotenv.config({ override: true });

const HAS_DB = Boolean(
  process.env.SUPABASE_DB_URL ||
    process.env.DATABASE_URL ||
    (process.env.SQL_HOST && process.env.SQL_DB_NAME && process.env.SQL_USER),
);
const TEST_PLANT_A = 'TEST_PLANT_99';
const TEST_PLANT_B = 'TEST_PLANT_98';

describe.skipIf(!HAS_DB)('PostgreSQL Drizzle transaction & repository integration', () => {
  let plantAId = 0;
  let plantBId = 0;

  beforeAll(async () => {
    await db.delete(plants).where(inArray(plants.code, [TEST_PLANT_A, TEST_PLANT_B]));
    const plantA = await seedPlantDevelopment(TEST_PLANT_A);
    const plantB = await seedPlantDevelopment(TEST_PLANT_B);
    plantAId = plantA.id;
    plantBId = plantB.id;
  }, 20_000);

  afterAll(async () => {
    await db.delete(plants).where(inArray(plants.code, [TEST_PLANT_A, TEST_PLANT_B]));
    await closePool();
  }, 20_000);

  it('persists all 19 devices in a single transaction, deduplicates retries, and blocks out-of-order overwrites', { timeout: 20_000 }, async () => {
    const groups = createInitialDeviceGroups();
    const allDevices = groups.flatMap((g) => g.devices);
    expect(allDevices).toHaveLength(19);

    const tNew = new Date(Date.now() + 5000);
    const tOld = new Date(Date.now() - 60_000);

    const baseKpis = {
      coolingLoadMw: 10.5,
      totalPowerMw: 2.1,
      systemCop: 5.0,
      wetBulbC: 26.5,
      chwSupplyC: 6.7,
      chwReturnC: 11.9,
      deltaTK: 5.2,
      cwSupplyC: 31.1,
      towerApproachK: 4.6,
      chillersOn: 3,
    };

    // 1. Ingest all 19 devices cleanly with Edge alarm
    const firstPayload = {
      plantCode: TEST_PLANT_A,
      edgeDeviceId: 'gw-test-99',
      batchId: 'db-test-batch-1',
      sequenceNumber: 10,
      payloadVersion: '1.0.0',
      observedAt: tNew.toISOString(),
      scenario: 'Peak Cooling' as const,
      quality: 'GOOD' as const,
      kpis: baseKpis,
      devices: allDevices.map((d, idx) => ({
        id: d.id,
        status: 'RUNNING' as const,
        quality: 'GOOD' as const,
        loadPct: Number((75 + idx * 0.5).toFixed(1)),
        metrics: { Load: Number((75 + idx * 0.5).toFixed(1)), COP: 6.1 },
      })),
      alarms: [
        {
          deviceId: 'ch-1',
          severity: 'WARN' as const,
          message: 'High condenser approach on Chiller #1',
          source: 'Edge Gateway',
          dedupeKey: 'ch1-high-approach',
        },
      ],
    };

    const firstRes = await ingestTelemetryBatch(plantAId, 'db-test-batch-1', firstPayload);

    expect(firstRes.deduplicated).toBe(false);
    expect(firstRes.ingestedDevices).toBe(19);

    const samplesAfterFirst = await db
      .select({ deviceId: deviceTelemetrySamples.deviceId })
      .from(deviceTelemetrySamples)
      .where(
        and(
          eq(deviceTelemetrySamples.plantId, plantAId),
          eq(deviceTelemetrySamples.idempotencyKey, 'db-test-batch-1'),
        ),
      );
    expect(samplesAfterFirst).toHaveLength(19);

    // 2. Retry with identical Idempotency-Key & identical payload must safely deduplicate
    const retryRes = await ingestTelemetryBatch(plantAId, 'db-test-batch-1', firstPayload);
    expect(retryRes.deduplicated).toBe(true);
    expect(retryRes.ingestedDevices).toBe(0);

    // 3. Out-of-order older packet must NOT overwrite fresher device_current_states
    const ch1DbId = `${TEST_PLANT_A}:ch-1`;
    await ingestTelemetryBatch(plantAId, 'db-test-batch-old', {
      plantCode: TEST_PLANT_A,
      edgeDeviceId: 'gw-test-99',
      batchId: 'db-test-batch-old',
      sequenceNumber: 5,
      payloadVersion: '1.0.0',
      observedAt: tOld.toISOString(),
      scenario: 'Part Load',
      quality: 'UNCERTAIN',
      kpis: { ...baseKpis, coolingLoadMw: 3.1 },
      devices: [
        {
          id: 'ch-1',
          status: 'STANDBY',
          quality: 'UNCERTAIN',
          loadPct: 12.0,
          metrics: { Load: 12.0 },
        },
      ],
      alarms: [
        {
          deviceId: 'ch-1',
          severity: 'WARN',
          message: 'High condenser approach on Chiller #1',
          source: 'Edge Gateway',
          dedupeKey: 'ch1-high-approach',
        },
      ],
    });

    const [currentCh1] = await db
      .select()
      .from(deviceCurrentStates)
      .where(eq(deviceCurrentStates.deviceId, ch1DbId))
      .limit(1);
    expect(currentCh1.loadPct).toBe(75);
    expect(currentCh1.status).toBe('RUNNING');
    expect(currentCh1.lastSequenceNumber).toBe(10);

    // 4. Verify alarm deduplication & lifecycle transitions + cross-plant isolation
    const [dedupedAlarm] = await db
      .select()
      .from(plantAlarms)
      .where(
        and(
          eq(plantAlarms.plantId, plantAId),
          eq(plantAlarms.dedupeKey, 'ch1-high-approach'),
        ),
      )
      .limit(1);
    expect(dedupedAlarm).toBeTruthy();
    expect(dedupedAlarm.occurrenceCount).toBe(2);

    // Cross-plant operator cannot acknowledge Plant A alarm via Plant B scope
    await expect(
      acknowledgeAlarm(plantBId, dedupedAlarm.id, 'intruder@plantb.local'),
    ).rejects.toBeInstanceOf(DomainError);

    const acked = await acknowledgeAlarm(plantAId, dedupedAlarm.id, 'op@planta.local');
    expect(acked.state).toBe('ACKNOWLEDGED');
    expect(acked.acknowledgedBy).toBe('op@planta.local');

    const cleared = await clearAlarm(plantAId, dedupedAlarm.id, 'op@planta.local');
    expect(cleared.state).toBe('CLEARED');

    // Cross-plant device trend query rejected cleanly
    await expect(
      getDeviceTrends(plantBId, ch1DbId, 50),
    ).rejects.toBeInstanceOf(DomainError);

    const trendsA = await getDeviceTrends(plantAId, 'ch-1', 50);
    expect(trendsA.points.length).toBeGreaterThanOrEqual(2);

    // Non-ch-1 devices also store historical samples cleanly
    const pumpTrends = await getDeviceTrends(plantAId, 'chwp-1', 50);
    expect(pumpTrends.points.length).toBeGreaterThanOrEqual(1);
    const valveTrends = await getDeviceTrends(plantAId, 'bv-1', 50);
    expect(valveTrends.points.length).toBeGreaterThanOrEqual(1);

    const snapshotA = await getPlantSnapshot(plantAId, TEST_PLANT_A, 'ADMIN');
    expect(snapshotA.deviceGroups.flatMap((g) => g.devices)).toHaveLength(19);
    expect(snapshotA.plant.sourceType).toBe('EDGE');
    expect(snapshotA.plant.isSimulated).toBe(false);

    const batchRows = await db
      .select()
      .from(telemetryBatches)
      .where(eq(telemetryBatches.plantId, plantAId));
    expect(batchRows).toHaveLength(2);

    const kpiRows = await db
      .select()
      .from(plantKpiSnapshots)
      .where(eq(plantKpiSnapshots.plantId, plantAId))
      .orderBy(desc(plantKpiSnapshots.sourceTimestamp));
    expect(kpiRows.length).toBeGreaterThanOrEqual(2);
  });

  it('handles parallel concurrent duplicate retries cleanly and rejects same-key payload mismatch with 409', { timeout: 20_000 }, async () => {
    const groups = createInitialDeviceGroups();
    const allDevices = groups.flatMap((g) => g.devices);
    const ts = new Date(Date.now() + 25_000);
    const concurrentPayload = {
      plantCode: TEST_PLANT_A,
      edgeDeviceId: 'gw-concurrent-99',
      batchId: 'db-concurrent-key-1',
      sequenceNumber: 200,
      payloadVersion: '1.0.0',
      observedAt: ts.toISOString(),
      scenario: 'Steady State' as const,
      quality: 'GOOD' as const,
      kpis: {
        coolingLoadMw: 9.2,
        totalPowerMw: 1.9,
        systemCop: 4.84,
        wetBulbC: 27.0,
        chwSupplyC: 6.9,
        chwReturnC: 11.7,
        deltaTK: 4.8,
        cwSupplyC: 31.5,
        towerApproachK: 4.5,
        chillersOn: 3,
      },
      devices: allDevices.map((d) => ({
        id: d.id,
        status: 'RUNNING' as const,
        quality: 'GOOD' as const,
        loadPct: 86.0,
        metrics: { Load: 86.0, COP: 6.0 },
      })),
    };

    // Parallel race with identical payload + identical Idempotency-Key
    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        ingestTelemetryBatch(plantAId, 'db-concurrent-key-1', concurrentPayload, {
          sourceType: 'SIMULATION',
        }),
      ),
    );
    const nonDedup = outcomes.filter((o) => !o.deduplicated);
    const dedup = outcomes.filter((o) => o.deduplicated);
    expect(nonDedup).toHaveLength(1);
    expect(dedup).toHaveLength(4);
    expect(outcomes.every((o) => o.isSimulated && o.sourceType === 'SIMULATION')).toBe(true);

    // Same Idempotency-Key with altered payload must reject with 409 IDEMPOTENCY_CONFLICT
    await expect(
      ingestTelemetryBatch(
        plantAId,
        'db-concurrent-key-1',
        {
          ...concurrentPayload,
          kpis: { ...concurrentPayload.kpis, coolingLoadMw: 12.4 },
        },
        { sourceType: 'SIMULATION' },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_CONFLICT',
    });

    // Verify Plant A snapshot reports SIMULATION provenance (never masquerading as EDGE live)
    const snapSim = await getPlantSnapshot(plantAId, TEST_PLANT_A, 'VIEWER');
    expect(snapSim.plant.isSimulated).toBe(true);
    expect(snapSim.plant.sourceType).toBe('SIMULATION');
  });

  it('marks seeded development plants as SEED/isSimulated and stores credentialType on rotation', { timeout: 20_000 }, async () => {
    const snapSeed = await getPlantSnapshot(plantBId, TEST_PLANT_B, 'VIEWER');
    expect(snapSeed.plant.isSimulated).toBe(true);
    expect(snapSeed.plant.sourceType).toBe('SEED');

    const first = await createOrRotateEdgeCredential(
      plantAId,
      'gw-rot-01',
      'Simulator GW',
      undefined,
      'SIMULATION',
    );
    const second = await createOrRotateEdgeCredential(
      plantAId,
      'gw-rot-01',
      'Rotated Real GW',
      undefined,
      'EDGE',
    );

    expect(first.credentialType).toBe('SIMULATION');
    expect(second.credentialType).toBe('EDGE');

    const rows = await db
      .select()
      .from(edgeCredentials)
      .where(
        and(
          eq(edgeCredentials.plantId, plantAId),
          eq(edgeCredentials.edgeDeviceId, 'gw-rot-01'),
        ),
      );
    const firstRow = rows.find((r) => r.credentialId === first.credentialId);
    const secondRow = rows.find((r) => r.credentialId === second.credentialId);
    expect(firstRow?.status).toBe('ROTATED');
    expect(firstRow?.credentialType).toBe('SIMULATION');
    expect(secondRow?.status).toBe('ACTIVE');
    expect(secondRow?.credentialType).toBe('EDGE');
  });
});
