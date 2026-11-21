export type DeviceCategory =
  | 'Chiller'
  | 'CHW Pump'
  | 'CW Pump'
  | 'Cooling Tower'
  | 'Aux Equipment'
  | 'Valves';

export type DeviceStatus = 'RUNNING' | 'STANDBY' | 'ISOLATED';

export type DataQuality = 'GOOD' | 'UNCERTAIN' | 'BAD' | 'STALE';

export type DataMode = 'live' | 'simulated';

export type FreshnessStatus = 'LIVE' | 'SIMULATED' | 'STALE' | 'OFFLINE' | 'ERROR';

export type AlarmState = 'ACTIVE' | 'ACKNOWLEDGED' | 'CLEARED';

export type AlarmSourceType = 'EDGE' | 'SYSTEM' | 'SIMULATION';

export type DataSourceType = 'EDGE' | 'SIMULATION' | 'SEED';

export type EdgeCredentialType = 'EDGE' | 'SIMULATION';

export type UserRole = 'VIEWER' | 'OPERATOR' | 'ADMIN';

export interface DeviceParameterRow {
  label: string;
  value: string;
  unit?: string;
  accent?: 'cyan' | 'emerald' | 'amber' | 'violet' | 'white';
}

export interface PlantDevice {
  id: string;
  deviceKey?: string;
  code: string;
  name: string;
  category: DeviceCategory;
  status: DeviceStatus;
  quality?: DataQuality;
  loadPct: number;
  meshKey: string;
  sourceTimestamp?: string;
  receivedAt?: string;
  lastSequenceNumber?: number;
  isSimulated?: boolean;
  sourceType?: DataSourceType;
  liveParams: DeviceParameterRow[];
  designParams: DeviceParameterRow[];
}

export interface DeviceGroup {
  category: DeviceCategory;
  displayCount: string;
  devices: PlantDevice[];
}

export interface LayerState {
  chillers: boolean;
  pumps: boolean;
  coolingTowers: boolean;
  valvesAux: boolean;
  chwPiping: boolean;
  cwPiping: boolean;
  flowIndicators: boolean;
  steelFrame: boolean;
}

export type LayerKey = keyof LayerState;

export interface AlarmEntry {
  id: string;
  numericId?: number;
  timestamp: string;
  occurredAt?: string;
  severity: 'INFO' | 'WARN' | 'CRIT';
  state?: AlarmState;
  sourceType?: AlarmSourceType;
  occurrenceCount?: number;
  message: string;
  source: string;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  clearedAt?: string | null;
}

export interface TrendPoint {
  timeSec: number;
  recordedAt?: string;
  loadPct: number;
  cop: number;
  chwOut: number;
  cwIn: number;
}

export type CameraPreset = 'Iso' | 'Top' | 'Front';

export type ScenarioId =
  | 'Steady State'
  | 'Peak Cooling'
  | 'Part Load'
  | 'High Wet Bulb';

export interface PlantKpis {
  coolingLoadMw: number;
  totalPowerMw: number;
  systemCop: number;
  wetBulbC: number;
  chwSupplyC: number;
  chwReturnC: number;
  deltaTK: number;
  cwSupplyC: number;
  towerApproachK: number;
  chillersOn: number;
}

export interface ProjectedLabel {
  id: string;
  text: string;
  x: number;
  y: number;
  visible: boolean;
}

export interface PlantSnapshotResponse {
  plant: {
    id: number;
    code: string;
    name: string;
    scenario: ScenarioId;
    role: UserRole;
    observedAt: string | null;
    receivedAt: string | null;
    quality: DataQuality;
    isSimulated: boolean;
    sourceType: DataSourceType;
    staleAfterSec: number;
  };
  kpis: PlantKpis;
  deviceGroups: DeviceGroup[];
  alarms: AlarmEntry[];
  trends: TrendPoint[];
}
