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

const HAS_DB = Boolean(process.env.SQL_HOST && process.env.SQL_DB_NAME && process.env.SQL_USER);
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
    const firstRes = await ingestTelemetryBatch(plantAId, 'db-test-batch-1', {
      plantCode: TEST_PLANT_A,
      edgeDeviceId: 'gw-test-99',
      batchId: 'db-test-batch-1',
      sequenceNumber: 10,
      payloadVersion: '1.0.0',
      observedAt: tNew.toISOString(),
      scenario: 'Peak Cooling',
      quality: 'GOOD',
      kpis: baseKpis,
      devices: allDevices.map((d, idx) => ({
        id: d.id,
        status: 'RUNNING',
        quality: 'GOOD',
        loadPct: Number((75 + idx * 0.5).toFixed(1)),
        metrics: { Load: Number((75 + idx * 0.5).toFixed(1)), COP: 6.1 },
      })),
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

    // 2. Retry with identical Idempotency-Key must safely deduplicate without inserting duplicate rows
    const retryRes = await ingestTelemetryBatch(plantAId, 'db-test-batch-1', {
      plantCode: TEST_PLANT_A,
      edgeDeviceId: 'gw-test-99',
      batchId: 'db-test-batch-1',
      sequenceNumber: 10,
      payloadVersion: '1.0.0',
      observedAt: tNew.toISOString(),
      scenario: 'Peak Cooling',
      quality: 'GOOD',
      kpis: baseKpis,
      devices: allDevices.map((d) => ({
        id: d.id,
        status: 'RUNNING',
        quality: 'GOOD',
        loadPct: 99,
        metrics: { Load: 99 },
      })),
    });
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

    const snapshotA = await getPlantSnapshot(plantAId, TEST_PLANT_A, 'ADMIN');
    expect(snapshotA.deviceGroups.flatMap((g) => g.devices)).toHaveLength(19);

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

  it('rotates prior ACTIVE edge credentials for the same edgeDeviceId', async () => {
    const first = await createOrRotateEdgeCredential(plantAId, 'gw-rot-01', 'Primary GW');
    const second = await createOrRotateEdgeCredential(plantAId, 'gw-rot-01', 'Rotated GW');

    expect(first.credentialId).not.toBe(second.credentialId);

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
    expect(secondRow?.status).toBe('ACTIVE');
  });
});
