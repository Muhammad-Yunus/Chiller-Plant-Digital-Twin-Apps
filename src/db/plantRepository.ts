import { desc, eq } from 'drizzle-orm';
import {
  createInitialDeviceGroups,
  createInitialTrends,
  INITIAL_ALARMS,
  INITIAL_KPIS,
} from '../data/plantData.ts';
import {
  AlarmEntry,
  DeviceCategory,
  DeviceGroup,
  DeviceParameterRow,
  DeviceStatus,
  PlantDevice,
  PlantKpis,
  ScenarioId,
  TrendPoint,
} from '../types/plant.ts';
import { db } from './index.ts';
import {
  deviceCurrentStates,
  deviceTelemetrySamples,
  plantAlarms,
  plantDevices,
  plantKpiSnapshots,
  plants,
} from './schema.ts';

export interface TelemetryIngestDeviceInput {
  id: string;
  status: DeviceStatus;
  loadPct: number;
  runHours?: number;
  metrics: Record<string, string | number>;
}

export interface TelemetryIngestInput {
  plantCode: string;
  scenario: ScenarioId;
  kpis: PlantKpis;
  devices: TelemetryIngestDeviceInput[];
  newAlarm?: {
    severity: 'INFO' | 'WARN' | 'CRIT';
    message: string;
    source: string;
    deviceId?: string;
  };
}

const CATEGORY_ORDER: DeviceCategory[] = [
  'Chiller',
  'CHW Pump',
  'CW Pump',
  'Cooling Tower',
  'Aux Equipment',
  'Valves',
];

function paramsToRecord(rows: DeviceParameterRow[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const row of rows) {
    out[row.label] = row.value;
  }
  return out;
}

function buildParameterRows(
  templateRows: DeviceParameterRow[],
  metrics: Record<string, string | number>,
): DeviceParameterRow[] {
  return templateRows.map((row) => {
    const val = metrics[row.label];
    return val !== undefined ? { ...row, value: String(val) } : row;
  });
}

function formatTimeHHMMSS(date: Date): string {
  return date.toISOString().slice(11, 19);
}

export async function ensurePlantSeeded(plantCode = 'CENTRAL_PLANT_01') {
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
      throw new Error('Plant record could not be initialized.');
    }

    const existingDevices = await db
      .select({ id: plantDevices.id })
      .from(plantDevices)
      .where(eq(plantDevices.plantId, plant.id))
      .limit(1);

    if (existingDevices.length === 0) {
      const initialGroups = createInitialDeviceGroups();
      let sortOrder = 0;

      for (const group of initialGroups) {
        for (const dev of group.devices) {
          sortOrder += 1;
          await db
            .insert(plantDevices)
            .values({
              id: dev.id,
              plantId: plant.id,
              code: dev.code,
              name: dev.name,
              category: dev.category,
              meshKey: dev.meshKey,
              sortOrder,
              designSpecs: paramsToRecord(dev.designParams),
            })
            .onConflictDoNothing({ target: plantDevices.id });

          const liveMetrics = paramsToRecord(dev.liveParams);
          const runHoursRaw = Number(liveMetrics['Run Hours'] ?? 40000);

          await db
            .insert(deviceCurrentStates)
            .values({
              deviceId: dev.id,
              status: dev.status,
              loadPct: dev.loadPct,
              runHours: Number.isFinite(runHoursRaw) ? Math.round(runHoursRaw) : 0,
              liveMetrics,
            })
            .onConflictDoNothing({ target: deviceCurrentStates.deviceId });
        }
      }

      await db.insert(plantKpiSnapshots).values({
        plantId: plant.id,
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
      await db.insert(deviceTelemetrySamples).values(
        seedTrends.map((pt, idx) => ({
          deviceId: 'ch-1',
          recordedAt: new Date(baseTimeMs + idx * 1000),
          status: 'RUNNING' as const,
          loadPct: pt.loadPct,
          cop: pt.cop,
          chwOutC: pt.chwOut,
          cwInC: pt.cwIn,
          powerKw: Number(((pt.loadPct / 100) * 585).toFixed(1)),
          capacityKw: Math.round((pt.loadPct / 100) * 3517),
        })),
      );

      await db.insert(plantAlarms).values(
        INITIAL_ALARMS.map((alm) => ({
          plantId: plant.id,
          severity: alm.severity,
          message: alm.message,
          source: alm.source,
        })),
      );
    }

    return plant;
  } catch (error) {
    console.error('Database seed/init query failed:', error);
    throw new Error('Failed to load plant configuration.', { cause: error });
  }
}

export async function getPlantSnapshot(plantCode = 'CENTRAL_PLANT_01') {
  try {
    const plant = await ensurePlantSeeded(plantCode);

    const [deviceRows, stateRows, kpiRows, alarmRows, trendRows] = await Promise.all([
      db
        .select()
        .from(plantDevices)
        .where(eq(plantDevices.plantId, plant.id))
        .orderBy(plantDevices.sortOrder),
      db.select().from(deviceCurrentStates),
      db
        .select()
        .from(plantKpiSnapshots)
        .where(eq(plantKpiSnapshots.plantId, plant.id))
        .orderBy(desc(plantKpiSnapshots.recordedAt))
        .limit(1),
      db
        .select()
        .from(plantAlarms)
        .where(eq(plantAlarms.plantId, plant.id))
        .orderBy(desc(plantAlarms.occurredAt))
        .limit(20),
      db
        .select()
        .from(deviceTelemetrySamples)
        .where(eq(deviceTelemetrySamples.deviceId, 'ch-1'))
        .orderBy(desc(deviceTelemetrySamples.recordedAt))
        .limit(120),
    ]);

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
      const tpl = templateMap.get(row.id);

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
        code: row.code,
        name: row.name,
        category: row.category,
        status: state?.status ?? 'RUNNING',
        loadPct: state?.loadPct ?? tpl?.loadPct ?? 0,
        meshKey: row.meshKey,
        liveParams,
        designParams,
      };

      const bucket = grouped.get(row.category);
      if (bucket) {
        bucket.push(device);
      }
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
      : INITIAL_KPIS;

    const alarms: AlarmEntry[] = alarmRows.map((a) => ({
      id: `alm-${a.id}`,
      timestamp: formatTimeHHMMSS(a.occurredAt),
      severity: a.severity === 'WARN' || a.severity === 'CRIT' ? 'WARN' : 'INFO',
      message: a.message,
      source: a.source,
    }));

    const orderedTrends = [...trendRows].reverse();
    const trends: TrendPoint[] = orderedTrends.map((t, idx) => ({
      timeSec: idx - orderedTrends.length,
      loadPct: t.loadPct,
      cop: t.cop ?? 6.01,
      chwOut: t.chwOutC ?? 6.9,
      cwIn: t.cwInC ?? 31.6,
    }));

    return {
      plant: {
        id: plant.id,
        code: plant.code,
        name: plant.name,
        scenario: (latestKpi?.scenario ?? 'Steady State') as ScenarioId,
      },
      kpis,
      deviceGroups,
      alarms,
      trends,
    };
  } catch (error) {
    console.error('Failed to fetch plant snapshot:', error);
    throw new Error('Failed to retrieve plant snapshot.', { cause: error });
  }
}

export async function getDeviceTrends(deviceId: string, limit = 300): Promise<TrendPoint[]> {
  try {
    const safeLimit = Math.max(10, Math.min(limit, 300));
    const rows = await db
      .select()
      .from(deviceTelemetrySamples)
      .where(eq(deviceTelemetrySamples.deviceId, deviceId))
      .orderBy(desc(deviceTelemetrySamples.recordedAt))
      .limit(safeLimit);

    const chronological = [...rows].reverse();
    return chronological.map((r, idx) => ({
      timeSec: idx - chronological.length,
      loadPct: r.loadPct,
      cop: r.cop ?? 6.01,
      chwOut: r.chwOutC ?? 6.9,
      cwIn: r.cwInC ?? 31.6,
    }));
  } catch (error) {
    console.error('Failed to fetch device trends:', error);
    throw new Error('Failed to retrieve device trend history.', { cause: error });
  }
}

export async function ingestTelemetry(input: TelemetryIngestInput) {
  try {
    const plant = await ensurePlantSeeded(input.plantCode);
    const now = new Date();

    await db.transaction(async (tx) => {
      await tx.insert(plantKpiSnapshots).values({
        plantId: plant.id,
        recordedAt: now,
        scenario: input.scenario,
        coolingLoadMw: input.kpis.coolingLoadMw,
        totalPowerMw: input.kpis.totalPowerMw,
        systemCop: input.kpis.systemCop,
        wetBulbC: input.kpis.wetBulbC,
        chwSupplyC: input.kpis.chwSupplyC,
        chwReturnC: input.kpis.chwReturnC,
        deltaTK: input.kpis.deltaTK,
        cwSupplyC: input.kpis.cwSupplyC,
        towerApproachK: input.kpis.towerApproachK,
        chillersOn: input.kpis.chillersOn,
      });

      for (const dev of input.devices) {
        await tx
          .insert(deviceCurrentStates)
          .values({
            deviceId: dev.id,
            status: dev.status,
            loadPct: dev.loadPct,
            runHours: dev.runHours ?? 42000,
            liveMetrics: dev.metrics,
            recordedAt: now,
          })
          .onConflictDoUpdate({
            target: deviceCurrentStates.deviceId,
            set: {
              status: dev.status,
              loadPct: dev.loadPct,
              liveMetrics: dev.metrics,
              recordedAt: now,
            },
          });

        if (dev.id === 'ch-1') {
          await tx.insert(deviceTelemetrySamples).values({
            deviceId: dev.id,
            recordedAt: now,
            status: dev.status,
            loadPct: dev.loadPct,
            powerKw: Number(dev.metrics['Power'] ?? 511.5),
            capacityKw: Number(dev.metrics['Capacity'] ?? 3072),
            cop: Number(dev.metrics['COP'] ?? 6.01),
            chwOutC: Number(dev.metrics['CHW Out'] ?? 6.9),
            chwInC: Number(dev.metrics['CHW In'] ?? 11.6),
            cwInC: Number(dev.metrics['CW In'] ?? 31.6),
            cwOutC: Number(dev.metrics['CW Out'] ?? 36.2),
          });
        }
      }

      if (input.newAlarm) {
        await tx.insert(plantAlarms).values({
          plantId: plant.id,
          deviceId: input.newAlarm.deviceId ?? null,
          occurredAt: now,
          severity: input.newAlarm.severity,
          message: input.newAlarm.message,
          source: input.newAlarm.source,
        });
      }
    });

    return { ok: true, recordedAt: now.toISOString() };
  } catch (error) {
    console.error('Failed to ingest telemetry:', error);
    throw new Error('Failed to persist telemetry sample.', { cause: error });
  }
}
