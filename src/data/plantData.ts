import {
  AlarmEntry,
  DeviceGroup,
  LayerState,
  PlantDevice,
  PlantKpis,
  ScenarioId,
  TrendPoint,
} from '../types/plant';

export const INITIAL_LAYER_STATE: LayerState = {
  chillers: true,
  pumps: true,
  coolingTowers: true,
  valvesAux: true,
  chwPiping: true,
  cwPiping: true,
  flowIndicators: true,
  steelFrame: false,
};

export const INITIAL_KPIS: PlantKpis = {
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
};

export const INITIAL_ALARMS: AlarmEntry[] = [
  {
    id: 'alm-1',
    timestamp: '01:58:21',
    severity: 'INFO',
    message: 'Chillers staged up to 3',
    source: 'Control Panel',
  },
  {
    id: 'alm-2',
    timestamp: '01:58:21',
    severity: 'INFO',
    message: 'Chillers staged up to 2',
    source: 'Control Panel',
  },
  {
    id: 'alm-3',
    timestamp: '01:58:21',
    severity: 'INFO',
    message: 'Chillers staged down to 1',
    source: 'Control Panel',
  },
];

export function createInitialDeviceGroups(): DeviceGroup[] {
  const chillers: PlantDevice[] = [1, 2, 3].map((idx) => ({
    id: `ch-${idx}`,
    code: `CH_1${idx}`,
    name: `Centrifugal Chiller #${idx}`,
    category: 'Chiller',
    status: 'RUNNING',
    loadPct: 87.4,
    meshKey: `chiller-${idx}`,
    liveParams: [
      { label: 'Load', value: '87.4', unit: '%', accent: 'cyan' },
      { label: 'Capacity', value: '3072', unit: 'kW', accent: 'cyan' },
      { label: 'Power', value: '511.5', unit: 'kW', accent: 'cyan' },
      { label: 'COP', value: '6.01', accent: 'cyan' },
      { label: 'CHW Out', value: '6.9', unit: '°C', accent: 'cyan' },
      { label: 'CHW In', value: '11.6', unit: '°C', accent: 'cyan' },
      { label: 'CW In', value: '31.6', unit: '°C', accent: 'cyan' },
      { label: 'CW Out', value: '36.2', unit: '°C', accent: 'cyan' },
      { label: 'Run Hours', value: String(42592 - (idx - 1) * 418), unit: 'h', accent: 'cyan' },
    ],
    designParams: [
      { label: 'Rated Capacity', value: '3517', unit: 'kW', accent: 'white' },
      { label: 'Rated Input', value: '585', unit: 'kW', accent: 'white' },
      { label: 'Rated COP', value: '6.01', accent: 'white' },
      { label: 'CHW Flow', value: '605', unit: 'm³/h', accent: 'white' },
      { label: 'CW Flow', value: '726', unit: 'm³/h', accent: 'white' },
      { label: 'Design', value: '7/12 · 32/37', unit: '°C', accent: 'white' },
    ],
  }));

  const chwPumps: PlantDevice[] = [1, 2, 3].map((idx) => ({
    id: `chwp-${idx}`,
    code: `CHWP_0${idx}`,
    name: `CHW Pump #${idx}`,
    category: 'CHW Pump',
    status: 'RUNNING',
    loadPct: 89.2,
    meshKey: `chw-pump-${idx}`,
    liveParams: [
      { label: 'Speed', value: '89.2', unit: '%', accent: 'cyan' },
      { label: 'Flow Rate', value: '540', unit: 'm³/h', accent: 'cyan' },
      { label: 'Power', value: '64.8', unit: 'kW', accent: 'cyan' },
      { label: 'Diff Head', value: '284', unit: 'kPa', accent: 'cyan' },
      { label: 'Motor Freq', value: '44.6', unit: 'Hz', accent: 'cyan' },
      { label: 'Suction P', value: '312', unit: 'kPa', accent: 'cyan' },
      { label: 'Discharge P', value: '596', unit: 'kPa', accent: 'cyan' },
      { label: 'Efficiency', value: '82.4', unit: '%', accent: 'cyan' },
      { label: 'Run Hours', value: String(38410 - (idx - 1) * 310), unit: 'h', accent: 'cyan' },
    ],
    designParams: [
      { label: 'Rated Flow', value: '605', unit: 'm³/h', accent: 'white' },
      { label: 'Rated Head', value: '320', unit: 'kPa', accent: 'white' },
      { label: 'Motor Power', value: '75', unit: 'kW', accent: 'white' },
      { label: 'Rated Speed', value: '1480', unit: 'RPM', accent: 'white' },
      { label: 'Drive Type', value: 'VFD', accent: 'white' },
      { label: 'Fluid', value: 'Chilled H₂O', accent: 'white' },
    ],
  }));

  const cwPumps: PlantDevice[] = [1, 2, 3].map((idx) => ({
    id: `cwp-${idx}`,
    code: `CWP_0${idx}`,
    name: `CW Pump #${idx}`,
    category: 'CW Pump',
    status: 'RUNNING',
    loadPct: 88.1,
    meshKey: `cw-pump-${idx}`,
    liveParams: [
      { label: 'Speed', value: '88.1', unit: '%', accent: 'cyan' },
      { label: 'Flow Rate', value: '640', unit: 'm³/h', accent: 'cyan' },
      { label: 'Power', value: '78.2', unit: 'kW', accent: 'cyan' },
      { label: 'Diff Head', value: '248', unit: 'kPa', accent: 'cyan' },
      { label: 'Motor Freq', value: '44.1', unit: 'Hz', accent: 'cyan' },
      { label: 'Suction P', value: '198', unit: 'kPa', accent: 'cyan' },
      { label: 'Discharge P', value: '446', unit: 'kPa', accent: 'cyan' },
      { label: 'Efficiency', value: '84.1', unit: '%', accent: 'cyan' },
      { label: 'Run Hours', value: String(40120 - (idx - 1) * 280), unit: 'h', accent: 'cyan' },
    ],
    designParams: [
      { label: 'Rated Flow', value: '726', unit: 'm³/h', accent: 'white' },
      { label: 'Rated Head', value: '280', unit: 'kPa', accent: 'white' },
      { label: 'Motor Power', value: '90', unit: 'kW', accent: 'white' },
      { label: 'Rated Speed', value: '1480', unit: 'RPM', accent: 'white' },
      { label: 'Drive Type', value: 'VFD', accent: 'white' },
      { label: 'Fluid', value: 'Condenser H₂O', accent: 'white' },
    ],
  }));

  const coolingTowers: PlantDevice[] = [1, 2].map((idx) => ({
    id: `ct-${idx}`,
    code: `CT_0${idx}`,
    name: `Cooling Tower #${idx}`,
    category: 'Cooling Tower',
    status: 'RUNNING',
    loadPct: 86.0,
    meshKey: `cooling-tower-${idx}`,
    liveParams: [
      { label: 'Fan Speed', value: '86.0', unit: '%', accent: 'cyan' },
      { label: 'Heat Reject', value: '5680', unit: 'kW', accent: 'cyan' },
      { label: 'Fan Power', value: '38.4', unit: 'kW', accent: 'cyan' },
      { label: 'Approach', value: '4.50', unit: 'K', accent: 'cyan' },
      { label: 'Range', value: '4.70', unit: 'K', accent: 'cyan' },
      { label: 'Basin Temp', value: '31.5', unit: '°C', accent: 'cyan' },
      { label: 'Inlet Temp', value: '36.2', unit: '°C', accent: 'cyan' },
      { label: 'Airflow', value: '184', unit: 'm³/s', accent: 'cyan' },
      { label: 'Run Hours', value: String(44110 - (idx - 1) * 215), unit: 'h', accent: 'cyan' },
    ],
    designParams: [
      { label: 'Nominal Reject', value: '6450', unit: 'kW', accent: 'white' },
      { label: 'Fan Motor', value: '45', unit: 'kW', accent: 'white' },
      { label: 'Design WB', value: '28.0', unit: '°C', accent: 'white' },
      { label: 'Design Range', value: '32/37', unit: '°C', accent: 'white' },
      { label: 'Type', value: 'Induced Draft', accent: 'white' },
      { label: 'Fill Media', value: 'PVC Crossflow', accent: 'white' },
    ],
  }));

  const auxEquipment: PlantDevice[] = [
    {
      id: 'as-1',
      code: 'AS_01',
      name: 'Air Separator #1',
      category: 'Aux Equipment',
      status: 'RUNNING',
      loadPct: 100.0,
      meshKey: 'air-separator',
      liveParams: [
        { label: 'Pressure', value: '442', unit: 'kPa', accent: 'cyan' },
        { label: 'Flow Thru', value: '1815', unit: 'm³/h', accent: 'cyan' },
        { label: 'Diff Press', value: '12.4', unit: 'kPa', accent: 'cyan' },
        { label: 'Dissolved O₂', value: '0.18', unit: 'mg/L', accent: 'cyan' },
        { label: 'Fluid Temp', value: '31.6', unit: '°C', accent: 'cyan' },
        { label: 'Vent State', value: 'Auto', accent: 'cyan' },
      ],
      designParams: [
        { label: 'Max Pressure', value: '1000', unit: 'kPa', accent: 'white' },
        { label: 'Vessel Dia', value: '900', unit: 'mm', accent: 'white' },
        { label: 'Connection', value: 'DN350', accent: 'white' },
        { label: 'Design', value: 'Tangential', accent: 'white' },
      ],
    },
    {
      id: 'cp-1',
      code: 'PLC_01',
      name: 'Plant Control Panel',
      category: 'Aux Equipment',
      status: 'RUNNING',
      loadPct: 100.0,
      meshKey: 'control-panel',
      liveParams: [
        { label: 'Active Stage', value: 'Stage 3', accent: 'cyan' },
        { label: 'CHW Setpt', value: '6.8', unit: '°C', accent: 'cyan' },
        { label: 'CW Setpt', value: '31.5', unit: '°C', accent: 'cyan' },
        { label: 'Scan Cycle', value: '250', unit: 'ms', accent: 'cyan' },
        { label: 'Bus Voltage', value: '400', unit: 'V', accent: 'cyan' },
        { label: 'Comms', value: 'BACnet IP', accent: 'cyan' },
      ],
      designParams: [
        { label: 'Controller', value: 'Dual PLC', accent: 'white' },
        { label: 'Protocol', value: 'BACnet/Modbus', accent: 'white' },
        { label: 'Enclosure', value: 'IP54', accent: 'white' },
      ],
    },
  ];

  const valves: PlantDevice[] = [1, 2, 3, 4, 5, 6].map((idx) => ({
    id: `bv-${idx}`,
    code: `BV_0${idx}`,
    name: idx <= 3 ? `CHW Isolation Valve #${idx}` : `CW Isolation Valve #${idx - 3}`,
    category: 'Valves',
    status: 'RUNNING',
    loadPct: 100,
    meshKey: `valve-${idx}`,
    liveParams: [
      { label: 'Position', value: '100', unit: '%', accent: 'cyan' },
      { label: 'Torque', value: '142', unit: 'Nm', accent: 'cyan' },
      { label: 'State', value: 'OPEN', accent: 'cyan' },
      { label: 'Actuator', value: '24V AC', accent: 'cyan' },
    ],
    designParams: [
      { label: 'Size', value: 'DN300', accent: 'white' },
      { label: 'Rating', value: 'PN16', accent: 'white' },
      { label: 'Type', value: 'Lugged Butterfly', accent: 'white' },
    ],
  }));

  return [
    { category: 'Chiller', displayCount: '3 units', devices: chillers },
    { category: 'CHW Pump', displayCount: '3 units', devices: chwPumps },
    { category: 'CW Pump', displayCount: '3 units', devices: cwPumps },
    { category: 'Cooling Tower', displayCount: '2 units', devices: coolingTowers },
    { category: 'Aux Equipment', displayCount: '2 units', devices: auxEquipment },
    { category: 'Valves', displayCount: '6 units', devices: valves },
  ];
}

// Seed initial trend history matching the crisp curve ramp in the reference image
export function createInitialTrends(): TrendPoint[] {
  const points: TrendPoint[] = [];
  const total = 95;
  for (let i = 0; i < total; i++) {
    const t = i / (total - 1); // 0 -> 1
    // Smooth transient startup ramp settling onto steady state (Load ~87.4%, COP ~6.01, CHW Out ~6.9C, CW In ~31.6C)
    const ease = 1 - Math.exp(-4.2 * t);
    const ripple = Math.sin(i * 0.35) * 0.45 * (1 - t * 0.4);
    points.push({
      timeSec: i - total,
      loadPct: Number((22 + 65.4 * ease + ripple * 1.4).toFixed(2)),
      cop: Number((2.4 + 3.61 * ease + Math.sin(i * 0.25) * 0.14).toFixed(2)),
      chwOut: Number((7.8 - 0.9 * ease + Math.cos(i * 0.4) * 0.08).toFixed(2)),
      cwIn: Number((27.2 + 4.4 * ease + Math.sin(i * 0.2) * 0.12).toFixed(2)),
    });
  }
  return points;
}

export const SCENARIO_TARGETS: Record<
  ScenarioId,
  {
    coolingLoadMw: number;
    wetBulbC: number;
    chwSupplyC: number;
    chwReturnC: number;
    cwSupplyC: number;
    chillersOn: number;
    chillerLoadPct: number;
    pumpLoadPct: number;
    cop: number;
  }
> = {
  'Steady State': {
    coolingLoadMw: 9.22,
    wetBulbC: 27.0,
    chwSupplyC: 6.9,
    chwReturnC: 11.7,
    cwSupplyC: 31.5,
    chillersOn: 3,
    chillerLoadPct: 87.4,
    pumpLoadPct: 89.0,
    cop: 6.01,
  },
  'Peak Cooling': {
    coolingLoadMw: 10.35,
    wetBulbC: 28.4,
    chwSupplyC: 7.0,
    chwReturnC: 12.6,
    cwSupplyC: 32.8,
    chillersOn: 3,
    chillerLoadPct: 98.1,
    pumpLoadPct: 96.5,
    cop: 5.62,
  },
  'Part Load': {
    coolingLoadMw: 5.48,
    wetBulbC: 25.2,
    chwSupplyC: 6.8,
    chwReturnC: 10.4,
    cwSupplyC: 29.4,
    chillersOn: 2,
    chillerLoadPct: 77.9,
    pumpLoadPct: 72.0,
    cop: 6.38,
  },
  'High Wet Bulb': {
    coolingLoadMw: 9.15,
    wetBulbC: 30.1,
    chwSupplyC: 7.1,
    chwReturnC: 11.8,
    cwSupplyC: 34.4,
    chillersOn: 3,
    chillerLoadPct: 86.7,
    pumpLoadPct: 92.4,
    cop: 5.18,
  },
};
