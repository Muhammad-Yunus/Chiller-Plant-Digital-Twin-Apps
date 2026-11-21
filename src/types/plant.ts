export type DeviceCategory =
  | 'Chiller'
  | 'CHW Pump'
  | 'CW Pump'
  | 'Cooling Tower'
  | 'Aux Equipment'
  | 'Valves';

export type DeviceStatus = 'RUNNING' | 'STANDBY' | 'ISOLATED';

export interface DeviceParameterRow {
  label: string;
  value: string;
  unit?: string;
  accent?: 'cyan' | 'emerald' | 'amber' | 'violet' | 'white';
}

export interface PlantDevice {
  id: string;
  code: string;
  name: string;
  category: DeviceCategory;
  status: DeviceStatus;
  loadPct: number;
  meshKey: string;
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
  timestamp: string;
  severity: 'INFO' | 'WARN';
  message: string;
  source: string;
}

export interface TrendPoint {
  timeSec: number;
  loadPct: number; // 0-100
  cop: number; // e.g. 4.0 - 7.0
  chwOut: number; // °C
  cwIn: number; // °C
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
