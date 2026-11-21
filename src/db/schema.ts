import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const deviceCategoryEnum = pgEnum('device_category', [
  'Chiller',
  'CHW Pump',
  'CW Pump',
  'Cooling Tower',
  'Aux Equipment',
  'Valves',
]);

export const deviceStatusEnum = pgEnum('device_status', [
  'RUNNING',
  'STANDBY',
  'ISOLATED',
]);

export const alarmSeverityEnum = pgEnum('alarm_severity', [
  'INFO',
  'WARN',
  'CRIT',
]);

// Authenticated operator/user table linked to Firebase Auth UID
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Central chilled water plants
export const plants = pgTable('plants', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 32 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  timezone: varchar('timezone', { length: 64 }).default('Asia/Jakarta').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Master equipment registry (19 units mapped 1:1 to PlantDevice & 3D meshKey)
export const plantDevices = pgTable(
  'plant_devices',
  {
    id: varchar('id', { length: 32 }).primaryKey(),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    code: varchar('code', { length: 24 }).notNull().unique(),
    name: varchar('name', { length: 100 }).notNull(),
    category: deviceCategoryEnum('category').notNull(),
    meshKey: varchar('mesh_key', { length: 64 }).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    designSpecs: jsonb('design_specs').$type<Record<string, string | number>>().default({}).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_plant_devices_plant_cat').on(table.plantId, table.category, table.sortOrder),
  ],
);

// Latest live snapshot per device for instant DEVICE TREE & DEVICE DETAIL hydration
export const deviceCurrentStates = pgTable('device_current_states', {
  deviceId: varchar('device_id', { length: 32 })
    .primaryKey()
    .references(() => plantDevices.id, { onDelete: 'cascade' }),
  status: deviceStatusEnum('status').default('STANDBY').notNull(),
  loadPct: real('load_pct').default(0).notNull(),
  runHours: integer('run_hours').default(0).notNull(),
  liveMetrics: jsonb('live_metrics').$type<Record<string, string | number>>().default({}).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
});

// 1 Hz time-series telemetry samples per device
export const deviceTelemetrySamples = pgTable(
  'device_telemetry_samples',
  {
    id: serial('id').primaryKey(),
    deviceId: varchar('device_id', { length: 32 })
      .notNull()
      .references(() => plantDevices.id, { onDelete: 'cascade' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    status: deviceStatusEnum('status').notNull(),
    loadPct: real('load_pct').notNull(),
    powerKw: real('power_kw'),
    capacityKw: real('capacity_kw'),
    cop: real('cop'),
    chwOutC: real('chw_out_c'),
    chwInC: real('chw_in_c'),
    cwInC: real('cw_in_c'),
    cwOutC: real('cw_out_c'),
    flowM3h: real('flow_m3h'),
    extraMetrics: jsonb('extra_metrics').$type<Record<string, string | number>>().default({}).notNull(),
  },
  (table) => [
    index('idx_dev_telemetry_device_time').on(table.deviceId, table.recordedAt),
  ],
);

// Plant-wide KPI snapshots (Header KPI strip + Bottom Status Bar)
export const plantKpiSnapshots = pgTable(
  'plant_kpi_snapshots',
  {
    id: serial('id').primaryKey(),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    scenario: varchar('scenario', { length: 32 }).default('Steady State').notNull(),
    coolingLoadMw: real('cooling_load_mw').notNull(),
    totalPowerMw: real('total_power_mw').notNull(),
    systemCop: real('system_cop').notNull(),
    wetBulbC: real('wet_bulb_c').notNull(),
    chwSupplyC: real('chw_supply_c').notNull(),
    chwReturnC: real('chw_return_c').notNull(),
    deltaTK: real('delta_t_k').notNull(),
    cwSupplyC: real('cw_supply_c').notNull(),
    towerApproachK: real('tower_approach_k').notNull(),
    chillersOn: integer('chillers_on').notNull(),
  },
  (table) => [
    index('idx_plant_kpi_plant_time').on(table.plantId, table.recordedAt),
  ],
);

// Plant alarms & staging log entries
export const plantAlarms = pgTable(
  'plant_alarms',
  {
    id: serial('id').primaryKey(),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 32 }).references(() => plantDevices.id, {
      onDelete: 'set null',
    }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    severity: alarmSeverityEnum('severity').default('INFO').notNull(),
    message: text('message').notNull(),
    source: varchar('source', { length: 80 }).notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_plant_alarms_occurred').on(table.plantId, table.occurredAt),
  ],
);

// Relations
export const plantsRelations = relations(plants, ({ many }) => ({
  devices: many(plantDevices),
  kpiSnapshots: many(plantKpiSnapshots),
  alarms: many(plantAlarms),
}));

export const plantDevicesRelations = relations(plantDevices, ({ one, many }) => ({
  plant: one(plants, {
    fields: [plantDevices.plantId],
    references: [plants.id],
  }),
  currentState: one(deviceCurrentStates, {
    fields: [plantDevices.id],
    references: [deviceCurrentStates.deviceId],
  }),
  telemetrySamples: many(deviceTelemetrySamples),
  alarms: many(plantAlarms),
}));

export const deviceCurrentStatesRelations = relations(deviceCurrentStates, ({ one }) => ({
  device: one(plantDevices, {
    fields: [deviceCurrentStates.deviceId],
    references: [plantDevices.id],
  }),
}));

export const deviceTelemetrySamplesRelations = relations(deviceTelemetrySamples, ({ one }) => ({
  device: one(plantDevices, {
    fields: [deviceTelemetrySamples.deviceId],
    references: [plantDevices.id],
  }),
}));

export const plantKpiSnapshotsRelations = relations(plantKpiSnapshots, ({ one }) => ({
  plant: one(plants, {
    fields: [plantKpiSnapshots.plantId],
    references: [plants.id],
  }),
}));

export const plantAlarmsRelations = relations(plantAlarms, ({ one }) => ({
  plant: one(plants, {
    fields: [plantAlarms.plantId],
    references: [plants.id],
  }),
  device: one(plantDevices, {
    fields: [plantAlarms.deviceId],
    references: [plantDevices.id],
  }),
}));
