import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
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

export const dataQualityEnum = pgEnum('data_quality', [
  'GOOD',
  'UNCERTAIN',
  'BAD',
  'STALE',
]);

export const alarmSeverityEnum = pgEnum('alarm_severity', [
  'INFO',
  'WARN',
  'CRIT',
]);

export const alarmStateEnum = pgEnum('alarm_state', [
  'ACTIVE',
  'ACKNOWLEDGED',
  'CLEARED',
]);

export const alarmSourceEnum = pgEnum('alarm_source', [
  'EDGE',
  'SYSTEM',
  'SIMULATION',
]);

export const userRoleEnum = pgEnum('user_role', [
  'VIEWER',
  'OPERATOR',
  'ADMIN',
]);

export const credentialStatusEnum = pgEnum('credential_status', [
  'ACTIVE',
  'ROTATED',
  'REVOKED',
]);

export const credentialTypeEnum = pgEnum('credential_type', [
  'EDGE',
  'SIMULATION',
]);

export const dataSourceEnum = pgEnum('data_source', [
  'EDGE',
  'SIMULATION',
  'SEED',
]);

// Authenticated operator/user table linked to Firebase Auth UID
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Central chilled water plants (tenant root)
export const plants = pgTable('plants', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 32 }).notNull().unique(),
  name: varchar('name', { length: 120 }).notNull(),
  timezone: varchar('timezone', { length: 64 }).default('Asia/Jakarta').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Plant-scoped RBAC ownership & permissions
export const userPlantRoles = pgTable(
  'user_plant_roles',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    role: userRoleEnum('role').default('VIEWER').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_user_plant_role').on(table.userId, table.plantId),
  ],
);

// Dedicated IoT edge gateway credentials (rotatable, hashed, plant-scoped)
export const edgeCredentials = pgTable(
  'edge_credentials',
  {
    id: serial('id').primaryKey(),
    credentialId: varchar('credential_id', { length: 64 }).notNull().unique(),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    edgeDeviceId: varchar('edge_device_id', { length: 64 }).notNull(),
    label: varchar('label', { length: 120 }).notNull(),
    secretHash: text('secret_hash').notNull(),
    secretSalt: text('secret_salt').notNull(),
    status: credentialStatusEnum('status').default('ACTIVE').notNull(),
    credentialType: credentialTypeEnum('credential_type').default('EDGE').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_edge_credentials_plant').on(table.plantId, table.status),
  ],
);

// Master equipment registry with multi-plant composite uniqueness
export const plantDevices = pgTable(
  'plant_devices',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    deviceKey: varchar('device_key', { length: 32 }).notNull(),
    code: varchar('code', { length: 32 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    category: deviceCategoryEnum('category').notNull(),
    meshKey: varchar('mesh_key', { length: 64 }).notNull(),
    sortOrder: integer('sort_order').default(0).notNull(),
    designSpecs: jsonb('design_specs').$type<Record<string, string | number>>().default({}).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('uq_plant_devices_plant_key').on(table.plantId, table.deviceKey),
    uniqueIndex('uq_plant_devices_plant_code').on(table.plantId, table.code),
    index('idx_plant_devices_plant_cat').on(table.plantId, table.category, table.sortOrder),
  ],
);

// Latest live snapshot per device with freshness & provenance metadata
export const deviceCurrentStates = pgTable(
  'device_current_states',
  {
    deviceId: varchar('device_id', { length: 64 })
      .primaryKey()
      .references(() => plantDevices.id, { onDelete: 'cascade' }),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    status: deviceStatusEnum('status').default('STANDBY').notNull(),
    quality: dataQualityEnum('quality').default('GOOD').notNull(),
    loadPct: real('load_pct').default(0).notNull(),
    runHours: integer('run_hours').default(0).notNull(),
    liveMetrics: jsonb('live_metrics').$type<Record<string, number | string>>().default({}).notNull(),
    sourceTimestamp: timestamp('source_timestamp', { withTimezone: true }).defaultNow().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    lastSequenceNumber: integer('last_sequence_number').default(0).notNull(),
    edgeDeviceId: varchar('edge_device_id', { length: 64 }),
    payloadVersion: varchar('payload_version', { length: 24 }),
    isSimulated: boolean('is_simulated').default(false).notNull(),
    sourceType: dataSourceEnum('source_type').default('EDGE').notNull(),
  },
  (table) => [
    index('idx_device_current_plant_ts').on(table.plantId, table.sourceTimestamp),
  ],
);

// Idempotency & provenance ledger for ingested batches
export const telemetryBatches = pgTable(
  'telemetry_batches',
  {
    id: serial('id').primaryKey(),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    edgeDeviceId: varchar('edge_device_id', { length: 64 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    payloadVersion: varchar('payload_version', { length: 24 }).notNull(),
    sourceTimestamp: timestamp('source_timestamp', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    sampleCount: integer('sample_count').notNull(),
    payloadHash: varchar('payload_hash', { length: 64 }),
    sourceType: dataSourceEnum('source_type').default('EDGE').notNull(),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => [
    uniqueIndex('uq_telemetry_batches_idem').on(
      table.plantId,
      table.edgeDeviceId,
      table.idempotencyKey,
    ),
    index('idx_telemetry_batches_plant_time').on(table.plantId, table.receivedAt),
  ],
);

// 1 Hz time-series telemetry samples for ALL devices with full provenance
export const deviceTelemetrySamples = pgTable(
  'device_telemetry_samples',
  {
    id: serial('id').primaryKey(),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 64 })
      .notNull()
      .references(() => plantDevices.id, { onDelete: 'cascade' }),
    sourceTimestamp: timestamp('source_timestamp', { withTimezone: true }).defaultNow().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    quality: dataQualityEnum('quality').default('GOOD').notNull(),
    sequenceNumber: integer('sequence_number').default(0).notNull(),
    edgeDeviceId: varchar('edge_device_id', { length: 64 }),
    payloadVersion: varchar('payload_version', { length: 24 }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    isSimulated: boolean('is_simulated').default(false).notNull(),
    sourceType: dataSourceEnum('source_type').default('EDGE').notNull(),
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
    extraMetrics: jsonb('extra_metrics').$type<Record<string, number | string>>().default({}).notNull(),
  },
  (table) => [
    index('idx_dev_telemetry_plant_device_time').on(
      table.plantId,
      table.deviceId,
      table.sourceTimestamp,
    ),
    index('idx_dev_telemetry_device_time').on(table.deviceId, table.recordedAt),
  ],
);

// Plant-wide KPI snapshots
export const plantKpiSnapshots = pgTable(
  'plant_kpi_snapshots',
  {
    id: serial('id').primaryKey(),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    sourceTimestamp: timestamp('source_timestamp', { withTimezone: true }).defaultNow().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    quality: dataQualityEnum('quality').default('GOOD').notNull(),
    sequenceNumber: integer('sequence_number').default(0).notNull(),
    edgeDeviceId: varchar('edge_device_id', { length: 64 }),
    payloadVersion: varchar('payload_version', { length: 24 }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    isSimulated: boolean('is_simulated').default(false).notNull(),
    sourceType: dataSourceEnum('source_type').default('EDGE').notNull(),
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
    index('idx_plant_kpi_plant_time').on(table.plantId, table.sourceTimestamp),
  ],
);

// Plant alarms with lifecycle, deduplication & audit trail
export const plantAlarms = pgTable(
  'plant_alarms',
  {
    id: serial('id').primaryKey(),
    plantId: integer('plant_id')
      .notNull()
      .references(() => plants.id, { onDelete: 'cascade' }),
    deviceId: varchar('device_id', { length: 64 }).references(() => plantDevices.id, {
      onDelete: 'set null',
    }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
    lastOccurredAt: timestamp('last_occurred_at', { withTimezone: true }).defaultNow().notNull(),
    severity: alarmSeverityEnum('severity').default('INFO').notNull(),
    state: alarmStateEnum('state').default('ACTIVE').notNull(),
    sourceType: alarmSourceEnum('source_type').default('EDGE').notNull(),
    dedupeKey: varchar('dedupe_key', { length: 128 }),
    occurrenceCount: integer('occurrence_count').default(1).notNull(),
    message: text('message').notNull(),
    source: varchar('source', { length: 80 }).notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    acknowledgedBy: text('acknowledged_by'),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedBy: text('cleared_by'),
  },
  (table) => [
    index('idx_plant_alarms_occurred').on(table.plantId, table.occurredAt),
    index('idx_plant_alarms_dedupe').on(table.plantId, table.dedupeKey, table.state),
  ],
);

// Relations
export const plantsRelations = relations(plants, ({ many }) => ({
  devices: many(plantDevices),
  kpiSnapshots: many(plantKpiSnapshots),
  alarms: many(plantAlarms),
  memberRoles: many(userPlantRoles),
  edgeCredentials: many(edgeCredentials),
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
  plant: one(plants, {
    fields: [deviceCurrentStates.plantId],
    references: [plants.id],
  }),
}));

export const deviceTelemetrySamplesRelations = relations(deviceTelemetrySamples, ({ one }) => ({
  device: one(plantDevices, {
    fields: [deviceTelemetrySamples.deviceId],
    references: [plantDevices.id],
  }),
  plant: one(plants, {
    fields: [deviceTelemetrySamples.plantId],
    references: [plants.id],
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
