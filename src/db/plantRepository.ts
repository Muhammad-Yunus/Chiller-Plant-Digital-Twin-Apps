import crypto from 'crypto';
import { and, desc, eq, or } from 'drizzle-orm';
import {
  createInitialDeviceGroups,
  createInitialTrends,
  INITIAL_ALARMS,
  INITIAL_KPIS,
} from '../data/plantData.ts';
import { generateEdgeSecret, hashEdgeSecret } from '../lib/edgeCrypto.ts';
import { realtimeBus } from '../lib/realtimeBus.ts';
import type {
  AlarmEntry,
  DataQuality,
  DeviceCategory,
  DeviceGroup,
  DeviceParameterRow,
  PlantDevice,
  PlantKpis,
  PlantSnapshotResponse,
  ScenarioId,
  TrendPoint,
  UserRole,
} from '../types/plant.ts';
import type { TelemetryIngestPayload } from '../validation/telemetrySchemas.ts';
import { db } from './index.ts';
import {
  deviceCurrentStates,
  deviceTelemetrySamples,
  edgeCredentials,
  plantAlarms,
  plantDevices,
  plantKpiSnapshots,
  plants,
  telemetryBatches,
  userPlantRoles,
  users,
} from './schema.ts';

const CATEGORY_ORDER: DeviceCategory[] = [
  'Chiller',
  'CHW Pump',
  'CW Pump',
  'Cooling Tower',
  'Aux Equipment',
  'Valves',
];

const STALE_AFTER_SEC = Number(process.env.TELEMETRY_STALE_AFTER_SEC ?? 15);

export class DomainError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function parseMetricValue(raw: string): number | string {
  const num = Number(raw);
  return raw !== '' && Number.isFinite(num) ? num : raw;
}

function paramsToTypedRecord(rows: DeviceParameterRow[]): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  for (const row of rows) {
    out[row.label] = parseMetricValue(row.value);
  }
  return out;
}

function buildParameterRows(
  templateRows: DeviceParameterRow[],
  metrics: Record<string, number | string>,
): DeviceParameterRow[] {
  return templateRows.map((row) => {
    const val = metrics[row.label];
    return val !== undefined ? { ...row, value: String(val) } : row;
  });
}

function formatTimeHHMMSS(date: Date): string {
  return date.toISOString().slice(11, 19);
}

function extractNumericMetric(
  metrics: Record<string, number | string>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const val = metrics[key];
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string') {
      const parsed = Number(val);
      if (val !== '' && Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Pure helper determining whether an incoming sample is newer than the current stored state.
 * Prevents out-of-order / delayed telemetry from overwriting fresher live readings.
 */
export function isNewerReading(
  incomingTs: Date,
  incomingSeq: number,
  currentTs: Date | null | undefined,
  currentSeq: number | null | undefined,
): boolean {
  if (!currentTs) return true;
  const incomingMs = incomingTs.getTime();
  const currentMs = currentTs.getTime();
  if (incomingMs > currentMs) return true;
  if (incomingMs < currentMs) return false;
  return incomingSeq > (currentSeq ?? -1);
}

export async function seedPlantDevelopment(plantCode = 'CENTRAL_PLANT_01') {
  try {
    await db
      .insert(plants)
      .values({
        code: plantCode,
        name: 'Chiller Plant Twin',
        timezone: 'Asia/Jakarta',
      })
      .onConflictDoNothing({ target: plants.code });

    const [plant] = await db
      .select()
      .from(plants)
      .where(eq(plants.code, plantCode))
      .limit(1);

    if (!plant) {
      throw new Error('Plant record could not be created.');
    }

    const existingDevices = await db
      .select({ id: plantDevices.id })
      .from(plantDevices)
      .where(eq(plantDevices.plantId, plant.id))
      .limit(1);

    if (existingDevices.length === 0) {
      const initialGroups = createInitialDeviceGroups();
      let sortOrder = 0;
      const now = new Date();

      for (const group of initialGroups) {
        for (const dev of group.devices) {
          sortOrder += 1;
          const dbId =
            plantCode === 'CENTRAL_PLANT_01' ? dev.id : `${plantCode}:${dev.id}`;
          await db
            .insert(plantDevices)
            .values({
              id: dbId,
              plantId: plant.id,
              deviceKey: dev.id,
              code: dev.code,
              name: dev.name,
              category: dev.category,
              meshKey: dev.meshKey,
              sortOrder,
              designSpecs: paramsToTypedRecord(dev.designParams),
            })
            .onConflictDoNothing({ target: plantDevices.id });

          const liveMetrics = paramsToTypedRecord(dev.liveParams);
          const runHoursRaw = Number(liveMetrics['Run Hours'] ?? 40000);

          await db
            .insert(deviceCurrentStates)
            .values({
              deviceId: dbId,
              plantId: plant.id,
              status: dev.status,
              quality: 'GOOD',
              loadPct: dev.loadPct,
              runHours: Number.isFinite(runHoursRaw) ? Math.round(runHoursRaw) : 0,
              liveMetrics,
              sourceTimestamp: now,
              receivedAt: now,
              recordedAt: now,
              lastSequenceNumber: 0,
              edgeDeviceId: 'seed-init',
              payloadVersion: '1.0.0',
            })
            .onConflictDoNothing({ target: deviceCurrentStates.deviceId });
        }
      }

      await db.insert(plantKpiSnapshots).values({
        plantId: plant.id,
        sourceTimestamp: now,
        receivedAt: now,
        recordedAt: now,
        quality: 'GOOD',
        sequenceNumber: 0,
        edgeDeviceId: 'seed-init',
        payloadVersion: '1.0.0',
        isSimulated: false,
        scenario: 'Steady State',
        coolingLoadMw: INITIAL_KPIS.coolingLoadMw,
        totalPowerMw: INITIAL_KPIS.totalPowerMw,
        systemCop: INITIAL_KPIS.systemCop,
        wetBulbC: INITIAL_KPIS.wetBulbC,
        chwSupplyC: INITIAL_KPIS.chwSupplyC,
        chwReturnC: INITIAL_KPIS.chwReturnC,
        deltaTK: INITIAL_KPIS.deltaTK,
        cwSupplyC: INITIAL_KPIS.cwSupplyC,
        towerApproachK: INITIAL_KPIS.towerApproachK,
        chillersOn: INITIAL_KPIS.chillersOn,
      });

      const seedTrends = createInitialTrends();
      const baseTimeMs = Date.now() - seedTrends.length * 1000;
      const ch1Id =
        plantCode === 'CENTRAL_PLANT_01' ? 'ch-1' : `${plantCode}:ch-1`;
      await db.insert(deviceTelemetrySamples).values(
        seedTrends.map((pt, idx) => {
          const ts = new Date(baseTimeMs + idx * 1000);
          return {
            plantId: plant.id,
            deviceId: ch1Id,
            sourceTimestamp: ts,
            receivedAt: ts,
            recordedAt: ts,
            quality: 'GOOD' as const,
            sequenceNumber: idx,
            edgeDeviceId: 'seed-init',
            payloadVersion: '1.0.0',
            status: 'RUNNING' as const,
            loadPct: pt.loadPct,
            cop: pt.cop,
            chwOutC: pt.chwOut,
            cwInC: pt.cwIn,
            powerKw: Number(((pt.loadPct / 100) * 585).toFixed(1)),
            capacityKw: Math.round((pt.loadPct / 100) * 3517),
          };
        }),
      );

      await db.insert(plantAlarms).values(
        INITIAL_ALARMS.map((alm, i) => ({
          plantId: plant.id,
          severity: alm.severity,
          state: 'ACTIVE' as const,
          sourceType: 'SYSTEM' as const,
          dedupeKey: `seed-alarm-${i + 1}`,
          message: alm.message,
          source: alm.source,
        })),
      );
    }

    return plant;
  } catch (error) {
    console.error('Database seed failed:', error);
    throw new Error('Failed to seed plant configuration.', { cause: error });
  }
}

export async function getPlantSnapshot(
  plantId: number,
  plantCode: string,
  role: UserRole,
): Promise<PlantSnapshotResponse> {
  try {
    const [plant] = await db
      .select()
      .from(plants)
      .where(eq(plants.id, plantId))
      .limit(1);

    if (!plant) {
      throw new DomainError(404, 'PLANT_NOT_FOUND', 'Plant not found');
    }

    const [deviceRows, stateRows, kpiRows, alarmRows] = await Promise.all([
      db
        .select()
        .from(plantDevices)
        .where(eq(plantDevices.plantId, plantId))
        .orderBy(plantDevices.sortOrder),
      db
        .select()
        .from(deviceCurrentStates)
        .where(eq(deviceCurrentStates.plantId, plantId)),
      db
        .select()
        .from(plantKpiSnapshots)
        .where(eq(plantKpiSnapshots.plantId, plantId))
        .orderBy(desc(plantKpiSnapshots.sourceTimestamp))
        .limit(1),
      db
        .select()
        .from(plantAlarms)
        .where(eq(plantAlarms.plantId, plantId))
        .orderBy(desc(plantAlarms.lastOccurredAt))
        .limit(30),
    ]);

    const firstDeviceId = deviceRows[0]?.id;
    const trendRows = firstDeviceId
      ? await db
          .select()
          .from(deviceTelemetrySamples)
          .where(
            and(
              eq(deviceTelemetrySamples.plantId, plantId),
              eq(deviceTelemetrySamples.deviceId, firstDeviceId),
            ),
          )
          .orderBy(desc(deviceTelemetrySamples.sourceTimestamp))
          .limit(300)
      : [];

    const stateMap = new Map(stateRows.map((s) => [s.deviceId, s]));
    const templateGroups = createInitialDeviceGroups();
    const templateMap = new Map(
      templateGroups.flatMap((g) => g.devices.map((d) => [d.id, d])),
    );

    const grouped = new Map<DeviceCategory, PlantDevice[]>();
    for (const cat of CATEGORY_ORDER) {
      grouped.set(cat, []);
    }

    for (const row of deviceRows) {
      const state = stateMap.get(row.id);
      const tpl = templateMap.get(row.deviceKey) ?? templateMap.get(row.id);

      const liveParams = tpl
        ? buildParameterRows(tpl.liveParams, state?.liveMetrics ?? {})
        : Object.entries(state?.liveMetrics ?? {}).map(([label, value]) => ({
            label,
            value: String(value),
            accent: 'cyan' as const,
          }));

      const designParams = tpl
        ? buildParameterRows(tpl.designParams, row.designSpecs ?? {})
        : Object.entries(row.designSpecs ?? {}).map(([label, value]) => ({
            label,
            value: String(value),
            accent: 'white' as const,
          }));

      const device: PlantDevice = {
        id: row.id,
        deviceKey: row.deviceKey,
        code: row.code,
        name: row.name,
        category: row.category,
        status: state?.status ?? 'STANDBY',
        quality: state?.quality ?? 'STALE',
        loadPct: state?.loadPct ?? 0,
        meshKey: row.meshKey,
        sourceTimestamp: state?.sourceTimestamp?.toISOString(),
        receivedAt: state?.receivedAt?.toISOString(),
        lastSequenceNumber: state?.lastSequenceNumber,
        liveParams,
        designParams,
      };

      grouped.get(row.category)?.push(device);
    }

    const deviceGroups: DeviceGroup[] = CATEGORY_ORDER.map((category) => {
      const devices = grouped.get(category) ?? [];
      return {
        category,
        displayCount: `${devices.length} units`,
        devices,
      };
    });

    const latestKpi = kpiRows[0];
    const kpis: PlantKpis = latestKpi
      ? {
          coolingLoadMw: latestKpi.coolingLoadMw,
          totalPowerMw: latestKpi.totalPowerMw,
          systemCop: latestKpi.systemCop,
          wetBulbC: latestKpi.wetBulbC,
          chwSupplyC: latestKpi.chwSupplyC,
          chwReturnC: latestKpi.chwReturnC,
          deltaTK: latestKpi.deltaTK,
          cwSupplyC: latestKpi.cwSupplyC,
          towerApproachK: latestKpi.towerApproachK,
          chillersOn: latestKpi.chillersOn,
        }
      : {
          coolingLoadMw: 0,
          totalPowerMw: 0,
          systemCop: 0,
          wetBulbC: 0,
          chwSupplyC: 0,
          chwReturnC: 0,
          deltaTK: 0,
          cwSupplyC: 0,
          towerApproachK: 0,
          chillersOn: 0,
        };

    const alarms: AlarmEntry[] = alarmRows.map((a) => ({
      id: `alm-${a.id}`,
      numericId: a.id,
      timestamp: formatTimeHHMMSS(a.lastOccurredAt),
      occurredAt: a.lastOccurredAt.toISOString(),
      severity: a.severity,
      state: a.state,
      sourceType: a.sourceType,
      occurrenceCount: a.occurrenceCount,
      message: a.message,
      source: a.source,
      acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      acknowledgedBy: a.acknowledgedBy ?? null,
      clearedAt: a.clearedAt?.toISOString() ?? null,
    }));

    const orderedTrends = [...trendRows].reverse();
    const trends: TrendPoint[] = orderedTrends.map((t, idx) => ({
      timeSec: idx - orderedTrends.length,
      recordedAt: t.sourceTimestamp.toISOString(),
      loadPct: t.loadPct,
      cop: t.cop ?? 0,
      chwOut: t.chwOutC ?? 0,
      cwIn: t.cwInC ?? 0,
    }));

    return {
      plant: {
        id: plant.id,
        code: plantCode,
        name: plant.name,
        scenario: (latestKpi?.scenario ?? 'Steady State') as ScenarioId,
        role,
        observedAt: latestKpi?.sourceTimestamp?.toISOString() ?? null,
        receivedAt: latestKpi?.receivedAt?.toISOString() ?? null,
        quality: (latestKpi?.quality ?? 'STALE') as DataQuality,
        staleAfterSec: STALE_AFTER_SEC,
      },
      kpis,
      deviceGroups,
      alarms,
      trends,
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    console.error('Failed to fetch plant snapshot:', error);
    throw new Error('Failed to retrieve plant snapshot.', { cause: error });
  }
}

export async function getDeviceTrends(
  plantId: number,
  deviceIdOrKey: string,
  limit = 300,
): Promise<{ deviceId: string; points: TrendPoint[] }> {
  try {
    // Enforce plant -> device ownership check to guarantee cross-plant isolation
    const [device] = await db
      .select({ id: plantDevices.id })
      .from(plantDevices)
      .where(
        and(
          eq(plantDevices.plantId, plantId),
          or(
            eq(plantDevices.id, deviceIdOrKey),
            eq(plantDevices.deviceKey, deviceIdOrKey),
          ),
        ),
      )
      .limit(1);

    if (!device) {
      throw new DomainError(404, 'DEVICE_NOT_FOUND', 'Device not found in authorized plant');
    }

    const safeLimit = Math.max(10, Math.min(limit, 300));
    const rows = await db
      .select()
      .from(deviceTelemetrySamples)
      .where(
        and(
          eq(deviceTelemetrySamples.plantId, plantId),
          eq(deviceTelemetrySamples.deviceId, device.id),
        ),
      )
      .orderBy(desc(deviceTelemetrySamples.sourceTimestamp))
      .limit(safeLimit);

    const chronological = [...rows].reverse();
    return {
      deviceId: device.id,
      points: chronological.map((r, idx) => ({
        timeSec: idx - chronological.length,
        recordedAt: r.sourceTimestamp.toISOString(),
        loadPct: r.loadPct,
        cop: r.cop ?? 0,
        chwOut: r.chwOutC ?? 0,
        cwIn: r.cwInC ?? 0,
      })),
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    console.error('Failed to fetch device trends:', error);
    throw new Error('Failed to retrieve device trend history.', { cause: error });
  }
}

export async function getPlantAlarms(plantId: number): Promise<AlarmEntry[]> {
  try {
    const rows = await db
      .select()
      .from(plantAlarms)
      .where(eq(plantAlarms.plantId, plantId))
      .orderBy(desc(plantAlarms.lastOccurredAt))
      .limit(50);

    return rows.map((a) => ({
      id: `alm-${a.id}`,
      numericId: a.id,
      timestamp: formatTimeHHMMSS(a.lastOccurredAt),
      occurredAt: a.lastOccurredAt.toISOString(),
      severity: a.severity,
      state: a.state,
      sourceType: a.sourceType,
      occurrenceCount: a.occurrenceCount,
      message: a.message,
      source: a.source,
      acknowledgedAt: a.acknowledgedAt?.toISOString() ?? null,
      acknowledgedBy: a.acknowledgedBy ?? null,
      clearedAt: a.clearedAt?.toISOString() ?? null,
    }));
  } catch (error) {
    console.error('Failed to fetch alarms:', error);
    throw new Error('Failed to retrieve plant alarms.', { cause: error });
  }
}

export async function acknowledgeAlarm(
  plantId: number,
  alarmNumericId: number,
  actorEmail: string,
): Promise<AlarmEntry> {
  try {
    const now = new Date();
    const [updated] = await db
      .update(plantAlarms)
      .set({
        state: 'ACKNOWLEDGED',
        acknowledgedAt: now,
        acknowledgedBy: actorEmail,
      })
      .where(and(eq(plantAlarms.id, alarmNumericId), eq(plantAlarms.plantId, plantId)))
      .returning();

    if (!updated) {
      throw new DomainError(404, 'ALARM_NOT_FOUND', 'Alarm not found in this plant');
    }

    const entry: AlarmEntry = {
      id: `alm-${updated.id}`,
      numericId: updated.id,
      timestamp: formatTimeHHMMSS(updated.lastOccurredAt),
      occurredAt: updated.lastOccurredAt.toISOString(),
      severity: updated.severity,
      state: updated.state,
      sourceType: updated.sourceType,
      occurrenceCount: updated.occurrenceCount,
      message: updated.message,
      source: updated.source,
      acknowledgedAt: updated.acknowledgedAt?.toISOString() ?? null,
      acknowledgedBy: updated.acknowledgedBy ?? null,
      clearedAt: updated.clearedAt?.toISOString() ?? null,
    };

    const [plant] = await db
      .select({ code: plants.code })
      .from(plants)
      .where(eq(plants.id, plantId))
      .limit(1);

    if (plant) {
      realtimeBus.publish(plantId, {
        type: 'alarm_update',
        plantCode: plant.code,
        observedAt: now.toISOString(),
        receivedAt: now.toISOString(),
        quality: 'GOOD',
        alarms: [entry],
      });
    }

    return entry;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    console.error('Failed to acknowledge alarm:', error);
    throw new Error('Failed to acknowledge alarm.', { cause: error });
  }
}

export async function clearAlarm(
  plantId: number,
  alarmNumericId: number,
  actorEmail: string,
): Promise<AlarmEntry> {
  try {
    const now = new Date();
    const [updated] = await db
      .update(plantAlarms)
      .set({
        state: 'CLEARED',
        clearedAt: now,
        clearedBy: actorEmail,
      })
      .where(and(eq(plantAlarms.id, alarmNumericId), eq(plantAlarms.plantId, plantId)))
      .returning();

    if (!updated) {
      throw new DomainError(404, 'ALARM_NOT_FOUND', 'Alarm not found in this plant');
    }

    const entry: AlarmEntry = {
      id: `alm-${updated.id}`,
      numericId: updated.id,
      timestamp: formatTimeHHMMSS(updated.lastOccurredAt),
      occurredAt: updated.lastOccurredAt.toISOString(),
      severity: updated.severity,
      state: updated.state,
      sourceType: updated.sourceType,
      occurrenceCount: updated.occurrenceCount,
      message: updated.message,
      source: updated.source,
      acknowledgedAt: updated.acknowledgedAt?.toISOString() ?? null,
      acknowledgedBy: updated.acknowledgedBy ?? null,
      clearedAt: updated.clearedAt?.toISOString() ?? null,
    };

    const [plant] = await db
      .select({ code: plants.code })
      .from(plants)
      .where(eq(plants.id, plantId))
      .limit(1);

    if (plant) {
      realtimeBus.publish(plantId, {
        type: 'alarm_update',
        plantCode: plant.code,
        observedAt: now.toISOString(),
        receivedAt: now.toISOString(),
        quality: 'GOOD',
        alarms: [entry],
      });
    }

    return entry;
  } catch (error) {
    if (error instanceof DomainError) throw error;
    console.error('Failed to clear alarm:', error);
    throw new Error('Failed to clear alarm.', { cause: error });
  }
}

export async function ingestTelemetryBatch(
  plantId: number,
  idempotencyKey: string,
  payload: TelemetryIngestPayload,
) {
  const receivedAt = new Date();
  const sourceTimestamp = new Date(payload.observedAt);

  try {
    const result = await db.transaction(async (tx) => {
      // 1. Idempotency check (retry-safe duplicate handling)
      const [existingBatch] = await tx
        .select({ id: telemetryBatches.id, receivedAt: telemetryBatches.receivedAt })
        .from(telemetryBatches)
        .where(
          and(
            eq(telemetryBatches.plantId, plantId),
            eq(telemetryBatches.edgeDeviceId, payload.edgeDeviceId),
            eq(telemetryBatches.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);

      if (existingBatch) {
        return {
          deduplicated: true,
          batchId: existingBatch.id,
          receivedAt: existingBatch.receivedAt.toISOString(),
          observedAt: sourceTimestamp.toISOString(),
          ingestedDevices: 0,
        };
      }

      // 2. Verify all referenced device IDs belong strictly to authorized plantId
      const plantDeviceRows = await tx
        .select({ id: plantDevices.id, deviceKey: plantDevices.deviceKey })
        .from(plantDevices)
        .where(eq(plantDevices.plantId, plantId));

      const validDeviceIds = new Set(plantDeviceRows.map((d) => d.id));
      const keyToIdMap = new Map(plantDeviceRows.map((d) => [d.deviceKey, d.id]));

      // Resolve deviceKey or exact plant device ID
      const resolvedDevices = payload.devices.map((item) => {
        const resolvedId = validDeviceIds.has(item.id)
          ? item.id
          : keyToIdMap.get(item.id);
        if (!resolvedId) {
          throw new DomainError(
            400,
            'UNKNOWN_DEVICE_FOR_PLANT',
            `Device ${item.id} does not belong to plant ${payload.plantCode}`,
          );
        }
        return { ...item, resolvedId };
      });

      // 3. Record provenance batch ledger
      const [insertedBatch] = await tx
        .insert(telemetryBatches)
        .values({
          plantId,
          edgeDeviceId: payload.edgeDeviceId,
          idempotencyKey,
          sequenceNumber: payload.sequenceNumber,
          payloadVersion: payload.payloadVersion,
          sourceTimestamp,
          receivedAt,
          sampleCount: resolvedDevices.length,
          rawPayload: payload as unknown as Record<string, unknown>,
        })
        .returning({ id: telemetryBatches.id });

      // 4. Out-of-order check for plant-wide KPI snapshot vs latest stored KPI
      const [latestKpi] = await tx
        .select({
          sourceTimestamp: plantKpiSnapshots.sourceTimestamp,
          sequenceNumber: plantKpiSnapshots.sequenceNumber,
        })
        .from(plantKpiSnapshots)
        .where(eq(plantKpiSnapshots.plantId, plantId))
        .orderBy(desc(plantKpiSnapshots.sourceTimestamp))
        .limit(1);

      const kpiIsNewer = isNewerReading(
        sourceTimestamp,
        payload.sequenceNumber,
        latestKpi?.sourceTimestamp,
        latestKpi?.sequenceNumber,
      );

      await tx.insert(plantKpiSnapshots).values({
        plantId,
        sourceTimestamp,
        receivedAt,
        recordedAt: sourceTimestamp,
        quality: payload.quality,
        sequenceNumber: payload.sequenceNumber,
        edgeDeviceId: payload.edgeDeviceId,
        payloadVersion: payload.payloadVersion,
        idempotencyKey,
        isSimulated: false,
        scenario: payload.scenario,
        coolingLoadMw: payload.kpis.coolingLoadMw,
        totalPowerMw: payload.kpis.totalPowerMw,
        systemCop: payload.kpis.systemCop,
        wetBulbC: payload.kpis.wetBulbC,
        chwSupplyC: payload.kpis.chwSupplyC,
        chwReturnC: payload.kpis.chwReturnC,
        deltaTK: payload.kpis.deltaTK,
        cwSupplyC: payload.kpis.cwSupplyC,
        towerApproachK: payload.kpis.towerApproachK,
        chillersOn: payload.kpis.chillersOn,
      });

      // 5. Persist samples for ALL devices and conditionally update current state only if newer
      const currentRows = await tx
        .select()
        .from(deviceCurrentStates)
        .where(eq(deviceCurrentStates.plantId, plantId));
      const currentStateMap = new Map(currentRows.map((c) => [c.deviceId, c]));

      const sampleInserts = [];
      const liveBroadcastUpdates: Array<{
        id: string;
        status: 'RUNNING' | 'STANDBY' | 'ISOLATED';
        quality: DataQuality;
        loadPct: number;
        sourceTimestamp: string;
        metrics: Record<string, number | string>;
      }> = [];

      for (const dev of resolvedDevices) {
        const devTs = dev.observedAt ? new Date(dev.observedAt) : sourceTimestamp;
        const existingState = currentStateMap.get(dev.resolvedId);

        sampleInserts.push({
          plantId,
          deviceId: dev.resolvedId,
          sourceTimestamp: devTs,
          receivedAt,
          recordedAt: devTs,
          quality: dev.quality,
          sequenceNumber: payload.sequenceNumber,
          edgeDeviceId: payload.edgeDeviceId,
          payloadVersion: payload.payloadVersion,
          idempotencyKey,
          status: dev.status,
          loadPct: dev.loadPct,
          powerKw: extractNumericMetric(dev.metrics, ['Power', 'Fan Power', 'powerKw']),
          capacityKw: extractNumericMetric(dev.metrics, ['Capacity', 'Heat Reject', 'capacityKw']),
          cop: extractNumericMetric(dev.metrics, ['COP', 'cop']),
          chwOutC: extractNumericMetric(dev.metrics, ['CHW Out', 'chwOutC']),
          chwInC: extractNumericMetric(dev.metrics, ['CHW In', 'chwInC']),
          cwInC: extractNumericMetric(dev.metrics, ['CW In', 'cwInC']),
          cwOutC: extractNumericMetric(dev.metrics, ['CW Out', 'cwOutC']),
          flowM3h: extractNumericMetric(dev.metrics, ['Flow Rate', 'Flow Thru', 'flowM3h']),
          extraMetrics: dev.metrics,
        });

        if (
          isNewerReading(
            devTs,
            payload.sequenceNumber,
            existingState?.sourceTimestamp,
            existingState?.lastSequenceNumber,
          )
        ) {
          await tx
            .insert(deviceCurrentStates)
            .values({
              deviceId: dev.resolvedId,
              plantId,
              status: dev.status,
              quality: dev.quality,
              loadPct: dev.loadPct,
              runHours: dev.runHours ?? existingState?.runHours ?? 0,
              liveMetrics: dev.metrics,
              sourceTimestamp: devTs,
              receivedAt,
              recordedAt: devTs,
              lastSequenceNumber: payload.sequenceNumber,
              edgeDeviceId: payload.edgeDeviceId,
              payloadVersion: payload.payloadVersion,
            })
            .onConflictDoUpdate({
              target: deviceCurrentStates.deviceId,
              set: {
                status: dev.status,
                quality: dev.quality,
                loadPct: dev.loadPct,
                runHours: dev.runHours ?? existingState?.runHours ?? 0,
                liveMetrics: dev.metrics,
                sourceTimestamp: devTs,
                receivedAt,
                recordedAt: devTs,
                lastSequenceNumber: payload.sequenceNumber,
                edgeDeviceId: payload.edgeDeviceId,
                payloadVersion: payload.payloadVersion,
              },
            });

          liveBroadcastUpdates.push({
            id: dev.resolvedId,
            status: dev.status,
            quality: dev.quality,
            loadPct: dev.loadPct,
            sourceTimestamp: devTs.toISOString(),
            metrics: dev.metrics,
          });
        }
      }

      if (sampleInserts.length > 0) {
        await tx.insert(deviceTelemetrySamples).values(sampleInserts);
      }

      // 6. Deduplicated Edge Alarm Ingestion
      const emittedAlarms: AlarmEntry[] = [];
      for (const alm of payload.alarms ?? []) {
        const resolvedAlarmDevId = alm.deviceId
          ? validDeviceIds.has(alm.deviceId)
            ? alm.deviceId
            : keyToIdMap.get(alm.deviceId) ?? null
          : null;
        const dedupeKey =
          alm.dedupeKey ??
          `${alm.severity}:${resolvedAlarmDevId ?? 'plant'}:${alm.message.slice(0, 64)}`;

        const [existingActive] = await tx
          .select()
          .from(plantAlarms)
          .where(
            and(
              eq(plantAlarms.plantId, plantId),
              eq(plantAlarms.dedupeKey, dedupeKey),
              eq(plantAlarms.state, 'ACTIVE'),
            ),
          )
          .limit(1);

        if (existingActive) {
          const [updatedAlarm] = await tx
            .update(plantAlarms)
            .set({
              lastOccurredAt: sourceTimestamp,
              occurrenceCount: existingActive.occurrenceCount + 1,
            })
            .where(eq(plantAlarms.id, existingActive.id))
            .returning();

          emittedAlarms.push({
            id: `alm-${updatedAlarm.id}`,
            numericId: updatedAlarm.id,
            timestamp: formatTimeHHMMSS(updatedAlarm.lastOccurredAt),
            occurredAt: updatedAlarm.lastOccurredAt.toISOString(),
            severity: updatedAlarm.severity,
            state: updatedAlarm.state,
            sourceType: updatedAlarm.sourceType,
            occurrenceCount: updatedAlarm.occurrenceCount,
            message: updatedAlarm.message,
            source: updatedAlarm.source,
          });
        } else {
          const [createdAlarm] = await tx
            .insert(plantAlarms)
            .values({
              plantId,
              deviceId: resolvedAlarmDevId,
              occurredAt: sourceTimestamp,
              lastOccurredAt: sourceTimestamp,
              severity: alm.severity,
              state: 'ACTIVE',
              sourceType: 'EDGE',
              dedupeKey,
              occurrenceCount: 1,
              message: alm.message,
              source: alm.source,
            })
            .returning();

          emittedAlarms.push({
            id: `alm-${createdAlarm.id}`,
            numericId: createdAlarm.id,
            timestamp: formatTimeHHMMSS(createdAlarm.lastOccurredAt),
            occurredAt: createdAlarm.lastOccurredAt.toISOString(),
            severity: createdAlarm.severity,
            state: createdAlarm.state,
            sourceType: createdAlarm.sourceType,
            occurrenceCount: createdAlarm.occurrenceCount,
            message: createdAlarm.message,
            source: createdAlarm.source,
          });
        }
      }

      return {
        deduplicated: false,
        batchId: insertedBatch.id,
        receivedAt: receivedAt.toISOString(),
        observedAt: sourceTimestamp.toISOString(),
        ingestedDevices: resolvedDevices.length,
        kpiIsNewer,
        liveBroadcastUpdates,
        emittedAlarms,
      };
    });

    if (!result.deduplicated && (result.kpiIsNewer || result.liveBroadcastUpdates?.length)) {
      realtimeBus.publish(plantId, {
        type: 'telemetry_tick',
        plantCode: payload.plantCode,
        observedAt: result.observedAt,
        receivedAt: result.receivedAt,
        quality: payload.quality,
        scenario: payload.scenario,
        kpis: result.kpiIsNewer ? payload.kpis : undefined,
        deviceUpdates: result.liveBroadcastUpdates,
        alarms: result.emittedAlarms,
      });
    }

    return {
      ok: true,
      deduplicated: result.deduplicated,
      batchId: result.batchId,
      observedAt: result.observedAt,
      receivedAt: result.receivedAt,
      ingestedDevices: result.ingestedDevices,
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    console.error('Failed to ingest telemetry batch:', error);
    throw new Error('Failed to persist telemetry batch.', { cause: error });
  }
}

export async function createOrRotateEdgeCredential(
  plantId: number,
  edgeDeviceId: string,
  label: string,
  expiresInDays?: number,
) {
  try {
    const credentialId = `edge_${crypto.randomBytes(8).toString('hex')}`;
    const rawSecret = generateEdgeSecret();
    const { hash, salt } = hashEdgeSecret(rawSecret);
    const now = new Date();
    const expiresAt = expiresInDays
      ? new Date(now.getTime() + expiresInDays * 86400_000)
      : null;

    await db.transaction(async (tx) => {
      // Mark previous active credentials for the same edgeDeviceId in this plant as ROTATED
      await tx
        .update(edgeCredentials)
        .set({ status: 'ROTATED', rotatedAt: now })
        .where(
          and(
            eq(edgeCredentials.plantId, plantId),
            eq(edgeCredentials.edgeDeviceId, edgeDeviceId),
            eq(edgeCredentials.status, 'ACTIVE'),
          ),
        );

      await tx.insert(edgeCredentials).values({
        credentialId,
        plantId,
        edgeDeviceId,
        label,
        secretHash: hash,
        secretSalt: salt,
        status: 'ACTIVE',
        expiresAt,
      });
    });

    // Raw secret returned ONLY once at creation/rotation time
    return {
      credentialId,
      edgeDeviceId,
      label,
      secret: rawSecret,
      expiresAt: expiresAt?.toISOString() ?? null,
    };
  } catch (error) {
    console.error('Failed to create edge credential:', error);
    throw new Error('Failed to issue edge credential.', { cause: error });
  }
}

export async function listEdgeCredentials(plantId: number) {
  try {
    return await db
      .select({
        id: edgeCredentials.id,
        credentialId: edgeCredentials.credentialId,
        edgeDeviceId: edgeCredentials.edgeDeviceId,
        label: edgeCredentials.label,
        status: edgeCredentials.status,
        lastUsedAt: edgeCredentials.lastUsedAt,
        rotatedAt: edgeCredentials.rotatedAt,
        expiresAt: edgeCredentials.expiresAt,
        createdAt: edgeCredentials.createdAt,
      })
      .from(edgeCredentials)
      .where(eq(edgeCredentials.plantId, plantId))
      .orderBy(desc(edgeCredentials.createdAt));
  } catch (error) {
    console.error('Failed to list edge credentials:', error);
    throw new Error('Failed to retrieve edge credentials.', { cause: error });
  }
}

export async function assignPlantMember(
  plantId: number,
  email: string,
  role: UserRole,
) {
  try {
    const [targetUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!targetUser) {
      throw new DomainError(
        404,
        'USER_NOT_FOUND',
        'Operator must sign in at least once before role assignment',
      );
    }

    const [upserted] = await db
      .insert(userPlantRoles)
      .values({
        userId: targetUser.id,
        plantId,
        role,
      })
      .onConflictDoUpdate({
        target: [userPlantRoles.userId, userPlantRoles.plantId],
        set: { role },
      })
      .returning();

    return {
      userId: targetUser.id,
      email: targetUser.email,
      plantId,
      role: upserted.role,
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    console.error('Failed to assign plant member:', error);
    throw new Error('Failed to assign plant role.', { cause: error });
  }
}
