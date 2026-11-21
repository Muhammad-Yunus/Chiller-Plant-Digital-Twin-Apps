import { z } from 'zod';

export const PLANT_CODE_REGEX = /^[A-Z0-9_-]{3,32}$/;
export const DEVICE_ID_REGEX = /^[a-zA-Z0-9:_-]{2,64}$/;
export const PAYLOAD_VERSION_REGEX = /^\d+\.\d+(\.\d+)?$/;

export const plantCodeSchema = z
  .string()
  .trim()
  .regex(PLANT_CODE_REGEX, 'plantCode must match ^[A-Z0-9_-]{3,32}$');

export const deviceIdSchema = z
  .string()
  .trim()
  .regex(DEVICE_ID_REGEX, 'deviceId must match ^[a-zA-Z0-9:_-]{2,64}$');

export const scenarioSchema = z.enum([
  'Steady State',
  'Peak Cooling',
  'Part Load',
  'High Wet Bulb',
]);

export const deviceStatusSchema = z.enum(['RUNNING', 'STANDBY', 'ISOLATED']);
export const dataQualitySchema = z.enum(['GOOD', 'UNCERTAIN', 'BAD', 'STALE']);
export const alarmSeveritySchema = z.enum(['INFO', 'WARN', 'CRIT']);

export const kpisSchema = z
  .object({
    coolingLoadMw: z.number().finite().min(0).max(500),
    totalPowerMw: z.number().finite().min(0).max(200),
    systemCop: z.number().finite().min(0).max(15),
    wetBulbC: z.number().finite().min(-20).max(60),
    chwSupplyC: z.number().finite().min(-10).max(40),
    chwReturnC: z.number().finite().min(-10).max(50),
    deltaTK: z.number().finite().min(0).max(40),
    cwSupplyC: z.number().finite().min(0).max(65),
    towerApproachK: z.number().finite().min(0).max(30),
    chillersOn: z.number().int().min(0).max(20),
  })
  .strict();

export const deviceIngestItemSchema = z
  .object({
    id: deviceIdSchema,
    status: deviceStatusSchema,
    quality: dataQualitySchema.default('GOOD'),
    loadPct: z.number().finite().min(0).max(120),
    runHours: z.number().int().min(0).max(500000).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
    metrics: z
      .record(
        z.string().min(1).max(40),
        z.union([z.number().finite(), z.string().max(48)]),
      )
      .refine((obj) => Object.keys(obj).length <= 24, {
        message: 'Too many metrics keys (max 24)',
      }),
  })
  .strict();

export const alarmIngestItemSchema = z
  .object({
    deviceId: deviceIdSchema.optional(),
    severity: alarmSeveritySchema,
    message: z.string().trim().min(1).max(240),
    source: z.string().trim().min(1).max(80).default('Edge Gateway'),
    dedupeKey: z.string().trim().min(1).max(128).optional(),
  })
  .strict();

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export const telemetryIngestSchema = z
  .object({
    plantCode: plantCodeSchema,
    edgeDeviceId: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9._-]{2,64}$/, 'Invalid edgeDeviceId'),
    batchId: z.string().trim().min(4).max(128).optional(),
    sequenceNumber: z.number().int().min(0).max(2147483647),
    payloadVersion: z
      .string()
      .trim()
      .regex(PAYLOAD_VERSION_REGEX, 'payloadVersion must be semver like 1.0 or 1.0.0'),
    observedAt: z
      .string()
      .datetime({ offset: true })
      .refine((iso) => Date.parse(iso) <= Date.now() + MAX_FUTURE_SKEW_MS, {
        message: 'observedAt cannot be more than 5 minutes in the future',
      }),
    scenario: scenarioSchema.default('Steady State'),
    quality: dataQualitySchema.default('GOOD'),
    kpis: kpisSchema,
    devices: z.array(deviceIngestItemSchema).min(1).max(50),
    alarms: z.array(alarmIngestItemSchema).max(20).optional(),
  })
  .strict();

export const edgeCredentialCreateSchema = z
  .object({
    edgeDeviceId: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9._-]{2,64}$/, 'Invalid edgeDeviceId'),
    label: z.string().trim().min(2).max(120),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export const memberAssignSchema = z
  .object({
    email: z.string().email().max(255),
    role: z.enum(['VIEWER', 'OPERATOR', 'ADMIN']),
  })
  .strict();

export type TelemetryIngestPayload = z.infer<typeof telemetryIngestSchema>;
