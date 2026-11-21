import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import {
  Activity,
  Bell,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Layers,
  ListTree,
  LogIn,
  LogOut,
} from 'lucide-react';
import { auth, googleAuthProvider } from './lib/firebase';
import { TrendsChart } from './components/TrendsChart';
import {
  createInitialDeviceGroups,
  createInitialTrends,
  INITIAL_ALARMS,
  INITIAL_KPIS,
  INITIAL_LAYER_STATE,
  SCENARIO_TARGETS,
} from './data/plantData';
import { ChillerPlantScene } from './scene/ChillerPlantScene';
import {
  AlarmEntry,
  CameraPreset,
  DeviceCategory,
  DeviceGroup,
  LayerKey,
  LayerState,
  PlantDevice,
  PlantKpis,
  ProjectedLabel,
  ScenarioId,
  TrendPoint,
} from './types/plant';

const LAYER_ITEMS: Array<{ key: LayerKey; label: string }> = [
  { key: 'chillers', label: 'Chillers' },
  { key: 'pumps', label: 'Pumps' },
  { key: 'coolingTowers', label: 'Cooling Towers' },
  { key: 'valvesAux', label: 'Valves & Aux' },
  { key: 'chwPiping', label: 'CHW Piping' },
  { key: 'cwPiping', label: 'CW Piping' },
  { key: 'flowIndicators', label: 'Flow Indicators' },
  { key: 'steelFrame', label: 'Steel Frame' },
];

const SCENARIOS: ScenarioId[] = [
  'Steady State',
  'Peak Cooling',
  'Part Load',
  'High Wet Bulb',
];

function formatClock(totalSeconds: number): string {
  const sec = Math.floor(totalSeconds) % 86400;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<ChillerPlantScene | null>(null);

  const [deviceGroups, setDeviceGroups] = useState<DeviceGroup[]>(() =>
    createInitialDeviceGroups(),
  );
  const [expandedCategories, setExpandedCategories] = useState<
    Record<DeviceCategory, boolean>
  >({
    Chiller: true,
    'CHW Pump': true,
    'CW Pump': true,
    'Cooling Tower': false,
    'Aux Equipment': false,
    Valves: false,
  });

  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('ch-1');
  const [layers, setLayers] = useState<LayerState>(INITIAL_LAYER_STATE);
  const [alarms, setAlarms] = useState<AlarmEntry[]>(INITIAL_ALARMS);
  const [kpis, setKpis] = useState<PlantKpis>(INITIAL_KPIS);
  const [trends, setTrends] = useState<TrendPoint[]>(() =>
    createInitialTrends(),
  );

  // Simulation time starting at 01:58:35 (7115s) to match reference state
  const [simSeconds, setSimSeconds] = useState<number>(1 * 3600 + 58 * 60 + 35);
  const [isRunning, setIsRunning] = useState<boolean>(true);
  const [speedMultiplier, setSpeedMultiplier] = useState<1 | 10 | 60>(1);
  const [scenario, setScenario] = useState<ScenarioId>('Steady State');
  const [scenarioOpen, setScenarioOpen] = useState<boolean>(false);

  // 3D Viewport controls
  const [activePreset, setActivePreset] = useState<CameraPreset | null>('Iso');
  const [autoOrbit, setAutoOrbit] = useState<boolean>(false);
  const [explodeFactor, setExplodeFactor] = useState<number>(1.0);
  const [showLabels, setShowLabels] = useState<boolean>(true);
  const [projectedLabels, setProjectedLabels] = useState<ProjectedLabel[]>([]);
  const [fps, setFps] = useState<number>(60);

  // Firebase Auth state (token kept strictly in memory)
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const idTokenRef = useRef<string | null>(null);
  const syncTickCountRef = useRef<number>(0);

  const allDevices = useMemo(
    () => deviceGroups.flatMap((g) => g.devices),
    [deviceGroups],
  );

  const selectedDevice: PlantDevice = useMemo(() => {
    return (
      allDevices.find((d) => d.id === selectedDeviceId) ?? allDevices[0]
    );
  }, [allDevices, selectedDeviceId]);

  // Ref for selecting device from 3D raycasting without recreating WebGL scene
  const handleSelectMeshKeyRef = useRef<(meshKey: string) => void>(() => {});
  handleSelectMeshKeyRef.current = (meshKey: string) => {
    const found = allDevices.find((d) => d.meshKey === meshKey);
    if (found) {
      setSelectedDeviceId(found.id);
      setExpandedCategories((prev) => ({
        ...prev,
        [found.category]: true,
      }));
    }
  };

  // Mount Three.js scene once
  useEffect(() => {
    const mountEl = canvasMountRef.current;
    if (!mountEl) return;

    const plantScene = new ChillerPlantScene(mountEl, {
      onSelectMeshKey: (meshKey) => handleSelectMeshKeyRef.current(meshKey),
      onLabelsUpdate: (lbls) => setProjectedLabels(lbls),
      onFpsUpdate: (val) => setFps(val),
    });

    sceneRef.current = plantScene;

    return () => {
      plantScene.dispose();
      sceneRef.current = null;
    };
  }, []);

  // Sync layer visibility to Three.js scene
  useEffect(() => {
    sceneRef.current?.setLayers(layers);
  }, [layers]);

  // Sync selected device highlight
  useEffect(() => {
    if (selectedDevice) {
      sceneRef.current?.setSelectedMeshKey(selectedDevice.meshKey);
    }
  }, [selectedDevice]);

  // Sync simulation state to 3D scene
  useEffect(() => {
    sceneRef.current?.setRunning(isRunning);
  }, [isRunning]);

  useEffect(() => {
    sceneRef.current?.setSpeedMultiplier(speedMultiplier);
  }, [speedMultiplier]);

  useEffect(() => {
    sceneRef.current?.setExplodeFactor(explodeFactor);
  }, [explodeFactor]);

  useEffect(() => {
    sceneRef.current?.setShowLabels(showLabels);
  }, [showLabels]);

  // Listen to Firebase Auth state & hydrate persisted plant snapshot on sign-in
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (!user) {
        idTokenRef.current = null;
        return;
      }

      try {
        const token = await user.getIdToken();
        idTokenRef.current = token;

        const res = await fetch('/api/v1/plants/CENTRAL_PLANT_01/snapshot', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;

        const snapshot = (await res.json()) as {
          plant?: { scenario?: ScenarioId };
          kpis?: PlantKpis;
          deviceGroups?: DeviceGroup[];
          alarms?: AlarmEntry[];
          trends?: TrendPoint[];
        };
        if (snapshot.kpis) setKpis(snapshot.kpis);
        if (snapshot.deviceGroups?.length) setDeviceGroups(snapshot.deviceGroups);
        if (snapshot.alarms?.length) setAlarms(snapshot.alarms);
        if (snapshot.trends?.length) setTrends(snapshot.trends);
        if (snapshot.plant?.scenario) setScenario(snapshot.plant.scenario);
      } catch (err) {
        console.error('Snapshot hydration failed:', err);
      }
    });

    return () => unsubscribe();
  }, []);

  const latestStateRef = useRef({ kpis, scenario, deviceGroups });
  latestStateRef.current = { kpis, scenario, deviceGroups };

  const persistTelemetry = useCallback(
    async (newAlarm?: { severity: 'INFO' | 'WARN' | 'CRIT'; message: string; source: string }) => {
      const user = auth.currentUser;
      if (!user) return;
      try {
        const token = await user.getIdToken();
        idTokenRef.current = token;
        const { kpis: curKpis, scenario: curScenario, deviceGroups: curGroups } =
          latestStateRef.current;

        const devicesPayload = curGroups
          .flatMap((g) => g.devices)
          .slice(0, 11)
          .map((d) => ({
            id: d.id,
            status: d.status,
            loadPct: d.loadPct,
            metrics: Object.fromEntries(d.liveParams.map((p) => [p.label, p.value])),
          }));

        await fetch('/api/v1/telemetry/ingest', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            plantCode: 'CENTRAL_PLANT_01',
            scenario: curScenario,
            kpis: curKpis,
            devices: devicesPayload,
            newAlarm,
          }),
        });
      } catch (err) {
        console.error('Telemetry sync error:', err);
      }
    },
    [],
  );

  // Live Thermodynamic Simulation Tick (1 Hz real-time scaled by multiplier)
  useEffect(() => {
    if (!isRunning) return;

    const intervalMs = speedMultiplier === 1 ? 1000 : speedMultiplier === 10 ? 300 : 150;
    const stepSimSec = speedMultiplier === 1 ? 1 : speedMultiplier === 10 ? 3 : 9;

    const timer = window.setInterval(() => {
      setSimSeconds((prev) => prev + stepSimSec);

      const target = SCENARIO_TARGETS[scenario];
      const jitter = (amp: number) => (Math.random() - 0.5) * amp;

      setKpis((prev) => {
        const nextLoad = Number(
          (prev.coolingLoadMw + (target.coolingLoadMw - prev.coolingLoadMw) * 0.22 + jitter(0.03)).toFixed(2),
        );
        const nextCop = Number(
          (prev.systemCop + (target.cop * 0.79 - prev.systemCop) * 0.22 + jitter(0.015)).toFixed(2),
        );
        const nextPower = Number((nextLoad / Math.max(nextCop, 2.5)).toFixed(2));
        const nextWb = Number(
          (prev.wetBulbC + (target.wetBulbC - prev.wetBulbC) * 0.22 + jitter(0.04)).toFixed(1),
        );
        const nextChwSup = Number(
          (prev.chwSupplyC + (target.chwSupplyC - prev.chwSupplyC) * 0.25 + jitter(0.02)).toFixed(1),
        );
        const nextChwRet = Number(
          (prev.chwReturnC + (target.chwReturnC - prev.chwReturnC) * 0.25 + jitter(0.02)).toFixed(1),
        );
        const nextCwSup = Number(
          (prev.cwSupplyC + (target.cwSupplyC - prev.cwSupplyC) * 0.25 + jitter(0.03)).toFixed(1),
        );
        const nextDeltaT = Number(Math.max(1.0, nextChwRet - nextChwSup).toFixed(1));
        const nextApproach = Number(Math.max(1.5, nextCwSup - nextWb).toFixed(2));

        return {
          coolingLoadMw: nextLoad,
          totalPowerMw: nextPower,
          systemCop: nextCop,
          wetBulbC: nextWb,
          chwSupplyC: nextChwSup,
          chwReturnC: nextChwRet,
          deltaTK: nextDeltaT,
          cwSupplyC: nextCwSup,
          towerApproachK: nextApproach,
          chillersOn: target.chillersOn,
        };
      });

      setTrends((prev) => {
        const last = prev[prev.length - 1];
        const nextPoint: TrendPoint = {
          timeSec: (last?.timeSec ?? 0) + stepSimSec,
          loadPct: Number(
            Math.max(
              15,
              Math.min(
                100,
                (last?.loadPct ?? 87.4) +
                  (target.chillerLoadPct - (last?.loadPct ?? 87.4)) * 0.2 +
                  jitter(0.55),
              ),
            ).toFixed(2),
          ),
          cop: Number(
            Math.max(
              3.2,
              Math.min(
                7.2,
                (last?.cop ?? 6.01) +
                  (target.cop - (last?.cop ?? 6.01)) * 0.2 +
                  jitter(0.06),
              ),
            ).toFixed(2),
          ),
          chwOut: Number(
            ((last?.chwOut ?? 6.9) + (target.chwSupplyC - (last?.chwOut ?? 6.9)) * 0.25 + jitter(0.05)).toFixed(2),
          ),
          cwIn: Number(
            ((last?.cwIn ?? 31.6) + (target.cwSupplyC - (last?.cwIn ?? 31.6)) * 0.25 + jitter(0.08)).toFixed(2),
          ),
        };
        const updated = [...prev, nextPoint];
        return updated.length > 300 ? updated.slice(updated.length - 300) : updated;
      });

      // Gently update chiller & pump loads in device tree
      setDeviceGroups((prev) =>
        prev.map((group) => {
          if (group.category === 'Chiller') {
            return {
              ...group,
              devices: group.devices.map((d, idx) => {
                const isActive = idx < target.chillersOn;
                const nextLoad = isActive
                  ? Number(
                      (
                        d.loadPct +
                        (target.chillerLoadPct - d.loadPct) * 0.22 +
                        jitter(0.3)
                      ).toFixed(1),
                    )
                  : 0;
                const capKw = Math.round((nextLoad / 100) * 3517);
                const pwrKw = (capKw / target.cop).toFixed(1);
                return {
                  ...d,
                  status: isActive ? 'RUNNING' : 'STANDBY',
                  loadPct: nextLoad,
                  liveParams: d.liveParams.map((p) => {
                    if (p.label === 'Load') return { ...p, value: nextLoad.toFixed(1) };
                    if (p.label === 'Capacity') return { ...p, value: String(capKw) };
                    if (p.label === 'Power') return { ...p, value: pwrKw };
                    if (p.label === 'COP') return { ...p, value: target.cop.toFixed(2) };
                    if (p.label === 'CHW Out') return { ...p, value: target.chwSupplyC.toFixed(1) };
                    if (p.label === 'CHW In') return { ...p, value: target.chwReturnC.toFixed(1) };
                    if (p.label === 'CW In') return { ...p, value: target.cwSupplyC.toFixed(1) };
                    return p;
                  }),
                };
              }),
            };
          }
          if (group.category === 'CHW Pump' || group.category === 'CW Pump') {
            return {
              ...group,
              devices: group.devices.map((d) => {
                const nextLoad = Number(
                  (d.loadPct + (target.pumpLoadPct - d.loadPct) * 0.2 + jitter(0.25)).toFixed(1),
                );
                return {
                  ...d,
                  loadPct: nextLoad,
                  liveParams: d.liveParams.map((p) =>
                    p.label === 'Speed' ? { ...p, value: nextLoad.toFixed(1) } : p,
                  ),
                };
              }),
            };
          }
          return group;
        }),
      );
      syncTickCountRef.current += 1;
      if (syncTickCountRef.current % 5 === 0 && idTokenRef.current) {
        void persistTelemetry();
      }
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [isRunning, speedMultiplier, scenario, persistTelemetry]);

  const toggleCategory = useCallback((cat: DeviceCategory) => {
    setExpandedCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));
  }, []);

  const toggleLayer = useCallback((key: LayerKey) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleCameraPreset = useCallback((preset: CameraPreset) => {
    setActivePreset(preset);
    setAutoOrbit(false);
    sceneRef.current?.setAutoOrbit(false);
    sceneRef.current?.setCameraPreset(preset);
  }, []);

  const handleToggleOrbit = useCallback(() => {
    setAutoOrbit((prev) => {
      const next = !prev;
      sceneRef.current?.setAutoOrbit(next);
      if (next) setActivePreset(null);
      return next;
    });
  }, []);

  const handleResetView = useCallback(() => {
    setActivePreset('Iso');
    setAutoOrbit(false);
    setExplodeFactor(1.0);
    setSelectedDeviceId('ch-1');
    sceneRef.current?.resetView();
  }, []);

  const handleSelectScenario = useCallback(
    (nextScenario: ScenarioId) => {
      setScenario(nextScenario);
      setScenarioOpen(false);
      const target = SCENARIO_TARGETS[nextScenario];
      const msg = `Scenario set: ${nextScenario} (${target.chillersOn} chillers)`;
      const severity = nextScenario === 'High Wet Bulb' ? 'WARN' : 'INFO';
      setAlarms((prev) => [
        {
          id: `alm-${Date.now()}`,
          timestamp: formatClock(simSeconds),
          severity,
          message: msg,
          source: 'Control Panel',
        },
        ...prev.slice(0, 14),
      ]);
      void persistTelemetry({
        severity,
        message: msg,
        source: 'Control Panel',
      });
    },
    [simSeconds, persistTelemetry],
  );

  const handleAuthAction = useCallback(async () => {
    try {
      if (currentUser) {
        await signOut(auth);
      } else {
        await signInWithPopup(auth, googleAuthProvider);
      }
    } catch (err) {
      console.error('Authentication action failed:', err);
    }
  }, [currentUser]);

  // Extract latest trend values for selected device or plant
  const latestTrend = trends[trends.length - 1] ?? {
    loadPct: 87.4,
    cop: 6.01,
    chwOut: 6.9,
    cwIn: 31.6,
  };

  return (
    <div className="w-screen h-screen flex flex-col bg-[#050b14] text-slate-200 overflow-hidden">
      {/* TOP HEADER BAR */}
      <header className="h-[52px] shrink-0 px-3.5 bg-[#060f1c] border-b border-sky-500/20 flex items-center justify-between gap-4 z-30">
        {/* Left: Brand Logo + Subtitle + 4 KPI Boxes */}
        <div className="flex items-center gap-4 min-w-0">
          <div className="flex items-center gap-2 shrink-0 pr-2">
            <Box className="w-[18px] h-[18px] text-[#38bdf8]" strokeWidth={1.8} />
            <span className="text-[15.5px] font-semibold tracking-tight text-white whitespace-nowrap">
              Chiller Plant Twin
            </span>
            <span className="text-[10px] font-medium tracking-[0.08em] uppercase text-slate-500 whitespace-nowrap ml-1">
              CENTRAL PLANT / DIGITAL TWIN
            </span>
          </div>

          {/* 4 Top KPI Cards */}
          <div className="hidden lg:flex items-center gap-2.5">
            <div className="kpi-card px-3 py-1 min-w-[138px]">
              <div className="text-[9px] font-semibold tracking-[0.09em] uppercase text-slate-400 leading-none mb-0.5">
                COOLING LOAD
              </div>
              <div className="font-mono-tabular text-[17px] font-semibold leading-tight text-[#38bdf8]">
                {kpis.coolingLoadMw.toFixed(2)}
                <span className="text-[10px] font-normal text-slate-500 ml-1">
                  MW
                </span>
              </div>
            </div>

            <div className="kpi-card px-3 py-1 min-w-[138px]">
              <div className="text-[9px] font-semibold tracking-[0.09em] uppercase text-slate-400 leading-none mb-0.5">
                TOTAL POWER
              </div>
              <div className="font-mono-tabular text-[17px] font-semibold leading-tight text-[#38bdf8]">
                {kpis.totalPowerMw.toFixed(2)}
                <span className="text-[10px] font-normal text-slate-500 ml-1">
                  MW
                </span>
              </div>
            </div>

            <div className="kpi-card px-3 py-1 min-w-[132px]">
              <div className="text-[9px] font-semibold tracking-[0.09em] uppercase text-slate-400 leading-none mb-0.5">
                SYSTEM COP
              </div>
              <div className="font-mono-tabular text-[17px] font-semibold leading-tight text-[#34d399]">
                {kpis.systemCop.toFixed(2)}
              </div>
            </div>

            <div className="kpi-card px-3 py-1 min-w-[132px]">
              <div className="text-[9px] font-semibold tracking-[0.09em] uppercase text-slate-400 leading-none mb-0.5">
                WET BULB
              </div>
              <div className="font-mono-tabular text-[17px] font-semibold leading-tight text-[#c084fc]">
                {kpis.wetBulbC.toFixed(1)}
                <span className="text-[10px] font-normal text-slate-500 ml-1">
                  °C
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Running State, Clock & Speed Multipliers */}
        <div className="flex items-center gap-4 shrink-0">
          <button
            type="button"
            onClick={() => setIsRunning((r) => !r)}
            className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-[0.09em] uppercase text-slate-300 hover:text-white transition-colors cursor-pointer"
            title={isRunning ? 'Pause Simulation' : 'Resume Simulation'}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                isRunning ? 'bg-emerald-400' : 'bg-amber-400'
              }`}
            />
            <span>{isRunning ? 'RUNNING' : 'PAUSED'}</span>
          </button>

          <div className="font-mono-tabular text-[14.5px] font-semibold tracking-wider text-slate-100">
            {formatClock(simSeconds)}
          </div>

          <div className="flex items-center border border-sky-500/25 bg-[#081220] rounded-[2px] overflow-hidden">
            {([1, 10, 60] as const).map((spd) => {
              const active = speedMultiplier === spd;
              return (
                <button
                  key={spd}
                  type="button"
                  onClick={() => setSpeedMultiplier(spd)}
                  className={`px-2 py-0.5 text-[11px] font-mono-tabular transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#0e4466] text-white font-semibold border-x border-sky-400/40'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-sky-500/10'
                  }`}
                >
                  ×{spd}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={handleAuthAction}
            className="flex items-center gap-1.5 px-2.5 py-1 border border-sky-500/25 bg-[#081220] hover:border-sky-400/60 hover:text-white text-[10.5px] font-medium text-slate-300 rounded-[2px] transition-colors cursor-pointer whitespace-nowrap shrink-0"
            title={currentUser ? currentUser.email ?? 'Signed in' : 'Sign in with Google'}
          >
            {currentUser ? (
              <>
                <LogOut className="w-3 h-3 text-[#38bdf8]" />
                <span className="max-w-[110px] truncate">
                  {currentUser.displayName || currentUser.email || 'Sign out'}
                </span>
              </>
            ) : (
              <>
                <LogIn className="w-3 h-3 text-[#38bdf8]" />
                <span>Sign in</span>
              </>
            )}
          </button>
        </div>
      </header>

      {/* MAIN VIEWPORT WORKSPACE */}
      <main className="relative flex-1 min-h-0 overflow-hidden bg-[#040a12]">
        {/* Full-Bleed 3D WebGL Canvas Mount */}
        <div
          ref={canvasMountRef}
          className="absolute inset-0 z-0 cursor-grab active:cursor-grabbing"
        />

        {/* Projected 3D Callout Labels Overlay */}
        {showLabels && (
          <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
            {projectedLabels.map(
              (lbl) =>
                lbl.visible && (
                  <div
                    key={lbl.id}
                    style={{
                      transform: `translate3d(${lbl.x.toFixed(1)}px, ${lbl.y.toFixed(1)}px, 0) translate(-50%, -50%)`,
                    }}
                    className="absolute top-0 left-0 px-2 py-[2px] text-[11px] font-medium text-slate-100 bg-[#07111f]/88 border border-sky-400/35 rounded-[3px] whitespace-nowrap shadow-[0_2px_10px_rgba(0,0,0,0.6)]"
                  >
                    {lbl.text}
                  </div>
                ),
            )}
          </div>
        )}

        {/* LEFT SIDEBAR: DEVICE TREE, LAYERS, ALARMS */}
        <aside className="absolute top-2.5 left-2.5 bottom-2.5 w-[262px] z-20 flex flex-col gap-2.5 pointer-events-auto">
          {/* 1. DEVICE TREE */}
          <section className="hud-panel flex-[1.32] min-h-0 flex flex-col">
            <span className="hud-corners" />
            <div className="px-2.5 py-1.5 border-b border-sky-500/15 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-1.5">
                <ListTree className="w-3.5 h-3.5 text-[#38bdf8]" />
                <h2 className="text-[10.5px] font-semibold tracking-[0.09em] uppercase text-slate-200">
                  DEVICE TREE
                </h2>
              </div>
              <span className="text-[10px] font-mono-tabular text-slate-500">
                19 units
              </span>
            </div>

            <div className="flex-1 overflow-y-auto hud-scroll px-1.5 py-1.5 space-y-1">
              {deviceGroups.map((group) => {
                const isExpanded = expandedCategories[group.category];
                return (
                  <div key={group.category}>
                    <button
                      type="button"
                      onClick={() => toggleCategory(group.category)}
                      className="w-full flex items-center justify-between px-1.5 py-1 text-[11.5px] text-slate-300 hover:text-white transition-colors cursor-pointer"
                    >
                      <span className="flex items-center gap-1.5">
                        {isExpanded ? (
                          <ChevronDown className="w-3 h-3 text-slate-400" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-slate-400" />
                        )}
                        <span className="w-2 h-[1.5px] bg-[#38bdf8]/80 inline-block" />
                        <span className="font-medium">{group.category}</span>
                      </span>
                      <span className="text-[10px] font-mono-tabular text-slate-500">
                        {group.displayCount}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="mt-0.5 space-y-0.5 pl-1">
                        {group.devices.map((dev) => {
                          const isSelected = dev.id === selectedDeviceId;
                          return (
                            <button
                              key={dev.id}
                              type="button"
                              onClick={() => setSelectedDeviceId(dev.id)}
                              className={`w-full flex items-center justify-between px-2 py-[4.5px] rounded-[2px] text-[11.5px] transition-colors cursor-pointer ${
                                isSelected
                                  ? 'bg-[#0c3148]/80 border border-sky-400/45 text-white'
                                  : 'border border-transparent text-slate-300 hover:bg-sky-500/10 hover:text-white'
                              }`}
                            >
                              <span className="flex items-center gap-2 truncate">
                                <span
                                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                    dev.status === 'RUNNING'
                                      ? 'bg-emerald-400'
                                      : 'bg-slate-500'
                                  }`}
                                />
                                <span className="truncate">{dev.name}</span>
                              </span>
                              <span className="font-mono-tabular text-[11px] text-slate-400 ml-2 shrink-0">
                                {Math.round(dev.loadPct)}%
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* 2. LAYERS */}
          <section className="hud-panel shrink-0 flex flex-col">
            <span className="hud-corners" />
            <div className="px-2.5 py-1.5 border-b border-sky-500/15 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-[#38bdf8]" />
              <h2 className="text-[10.5px] font-semibold tracking-[0.09em] uppercase text-slate-200">
                LAYERS
              </h2>
            </div>

            <div className="px-2.5 py-2 space-y-1.5">
              {LAYER_ITEMS.map(({ key, label }) => {
                const checked = layers[key];
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => toggleLayer(key)}
                    className="w-full flex items-center gap-2 text-[11.5px] text-slate-300 hover:text-white transition-colors cursor-pointer"
                  >
                    <span
                      className={`w-3.5 h-3.5 rounded-[2px] flex items-center justify-center border transition-colors ${
                        checked
                          ? 'bg-[#0ea5e9] border-[#38bdf8] text-[#04101c]'
                          : 'bg-[#07111e] border-slate-600/80 text-transparent'
                      }`}
                    >
                      <Check className="w-2.5 h-2.5" strokeWidth={3} />
                    </span>
                    <span
                      className={`w-2 h-[1.5px] inline-block ${
                        checked ? 'bg-[#38bdf8]/80' : 'bg-slate-600'
                      }`}
                    />
                    <span className={checked ? 'text-slate-200' : 'text-slate-500'}>
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* 3. ALARMS */}
          <section className="hud-panel flex-[0.72] min-h-0 flex flex-col">
            <span className="hud-corners" />
            <div className="px-2.5 py-1.5 border-b border-sky-500/15 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-1.5">
                <Bell className="w-3.5 h-3.5 text-[#38bdf8]" />
                <h2 className="text-[10.5px] font-semibold tracking-[0.09em] uppercase text-slate-200">
                  ALARMS
                </h2>
              </div>
              <span className="text-[10px] font-mono-tabular text-slate-500">
                {alarms.length}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto hud-scroll divide-y divide-sky-500/10">
              {alarms.map((alm) => (
                <div key={alm.id} className="px-2.5 py-1.5 flex items-start gap-2">
                  <span className="font-mono-tabular text-[10px] text-slate-500 shrink-0 pt-[1px]">
                    {alm.timestamp}
                  </span>
                  <div className="min-w-0 leading-snug">
                    <div className="text-[11px] text-slate-200 truncate">
                      <span
                        className={`font-mono-tabular font-semibold mr-1 ${
                          alm.severity === 'WARN'
                            ? 'text-amber-400'
                            : 'text-slate-300'
                        }`}
                      >
                        [{alm.severity}]
                      </span>
                      {alm.message}
                    </div>
                    <div className="text-[10px] text-slate-500">{alm.source}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </aside>

        {/* RIGHT SIDEBAR: DEVICE DETAIL, TRENDS */}
        <aside className="absolute top-2.5 right-2.5 bottom-2.5 w-[268px] z-20 flex flex-col gap-2.5 pointer-events-auto">
          {/* 1. DEVICE DETAIL */}
          <section className="hud-panel flex-[1.52] min-h-0 flex flex-col">
            <span className="hud-corners" />
            <div className="px-2.5 py-1.5 border-b border-sky-500/15 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-[#38bdf8]" />
                <h2 className="text-[10.5px] font-semibold tracking-[0.09em] uppercase text-slate-200">
                  DEVICE DETAIL
                </h2>
              </div>
              <span className="text-[10px] font-mono-tabular text-slate-400">
                {selectedDevice.code}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto hud-scroll px-3 py-2">
              <div className="flex items-center gap-1.5">
                <span
                  className={`px-1.5 py-[1px] text-[9.5px] font-semibold tracking-wider uppercase border rounded-[2px] ${
                    selectedDevice.status === 'RUNNING'
                      ? 'border-emerald-500/70 text-emerald-400 bg-emerald-500/10'
                      : 'border-amber-500/70 text-amber-400 bg-amber-500/10'
                  }`}
                >
                  {selectedDevice.status}
                </span>
                <span className="px-1.5 py-[1px] text-[9.5px] font-mono-tabular text-slate-300 border border-slate-600/70 bg-slate-800/40 rounded-[2px]">
                  {selectedDevice.code}
                </span>
              </div>

              <h3 className="text-[15px] font-semibold text-white mt-1.5 leading-tight">
                {selectedDevice.name}
              </h3>
              <div className="text-[11px] text-slate-500 mb-2">
                {selectedDevice.category}
              </div>

              <div className="text-[10.5px] font-medium text-slate-400 border-b border-sky-500/15 pb-1 mb-1.5">
                Live Parameters
              </div>

              <div className="space-y-[3px]">
                {selectedDevice.liveParams.map((param) => (
                  <div
                    key={param.label}
                    className="flex items-center justify-between text-[11.5px] py-[1px]"
                  >
                    <span className="text-slate-400">{param.label}</span>
                    <span className="font-mono-tabular font-semibold text-[#38bdf8]">
                      {param.value}
                      {param.unit && (
                        <span className="text-[10px] font-normal text-slate-500 ml-1">
                          {param.unit}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>

              <div className="text-[10.5px] font-medium text-slate-400 border-b border-sky-500/15 pb-1 mt-2.5 mb-1.5">
                Nameplate / Design
              </div>

              <div className="space-y-[3px]">
                {selectedDevice.designParams.map((param) => (
                  <div
                    key={param.label}
                    className="flex items-center justify-between text-[11.5px] py-[1px]"
                  >
                    <span className="text-slate-400">{param.label}</span>
                    <span className="font-mono-tabular font-semibold text-slate-100">
                      {param.value}
                      {param.unit && (
                        <span className="text-[10px] font-normal text-slate-500 ml-1">
                          {param.unit}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* 2. TRENDS */}
          <section className="hud-panel flex-[1.0] min-h-[190px] flex flex-col">
            <span className="hud-corners" />
            <div className="px-2.5 py-1.5 border-b border-sky-500/15 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-1.5">
                <Activity className="w-3.5 h-3.5 text-[#38bdf8]" />
                <h2 className="text-[10.5px] font-semibold tracking-[0.09em] uppercase text-slate-200">
                  TRENDS
                </h2>
              </div>
              <span className="text-[9.5px] font-mono-tabular tracking-wider text-slate-500">
                LAST 5 MIN · 1 Hz
              </span>
            </div>

            <div className="flex-1 min-h-0 px-2.5 py-2">
              <TrendsChart
                points={trends}
                currentLoad={latestTrend.loadPct.toFixed(1)}
                currentCop={latestTrend.cop.toFixed(2)}
                currentChwOut={latestTrend.chwOut.toFixed(1)}
                currentCwIn={latestTrend.cwIn.toFixed(1)}
              />
            </div>
          </section>
        </aside>

        {/* BOTTOM VIEWPORT CONTROLS BAR (Camera Presets, Explode, Labels) */}
        <div className="absolute bottom-2.5 left-[282px] z-20 flex items-center gap-1 bg-[#07111f]/95 border border-sky-500/25 px-1.5 py-1 rounded-[3px] pointer-events-auto shadow-[0_4px_20px_rgba(0,0,0,0.6)]">
          {(['Iso', 'Top', 'Front'] as CameraPreset[]).map((preset) => {
            const active = activePreset === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => handleCameraPreset(preset)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-[2px] transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#0e4466] text-white border border-sky-400/50'
                    : 'text-slate-300 hover:text-white hover:bg-sky-500/10 border border-transparent'
                }`}
              >
                {preset}
              </button>
            );
          })}

          <button
            type="button"
            onClick={handleToggleOrbit}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-[2px] transition-colors cursor-pointer ${
              autoOrbit
                ? 'bg-[#0e4466] text-white border border-sky-400/50'
                : 'text-slate-300 hover:text-white hover:bg-sky-500/10 border border-transparent'
            }`}
          >
            Orbit
          </button>

          <button
            type="button"
            onClick={handleResetView}
            className="px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:text-white hover:bg-sky-500/10 rounded-[2px] transition-colors cursor-pointer"
          >
            Reset
          </button>

          <span className="w-[1px] h-4 bg-sky-500/20 mx-1" />

          <div className="flex items-center gap-2 px-1">
            <span className="text-[11px] text-slate-400">Explode</span>
            <input
              type="range"
              min={1.0}
              max={2.5}
              step={0.01}
              value={explodeFactor}
              onChange={(e) => setExplodeFactor(parseFloat(e.target.value))}
              aria-label="Explode assembly factor"
              className="hud-slider w-[76px]"
            />
            <span className="font-mono-tabular text-[11px] text-[#38bdf8] w-[36px]">
              {explodeFactor.toFixed(2)}×
            </span>
          </div>

          <span className="w-[1px] h-4 bg-sky-500/20 mx-1" />

          <button
            type="button"
            onClick={() => setShowLabels((s) => !s)}
            className={`px-2.5 py-1 text-[11px] font-medium rounded-[2px] transition-colors cursor-pointer ${
              showLabels
                ? 'bg-[#0e4466] text-white border border-sky-400/50'
                : 'text-slate-400 hover:text-white hover:bg-sky-500/10 border border-transparent'
            }`}
          >
            Labels
          </button>
        </div>
      </main>

      {/* BOTTOM STATUS BAR */}
      <footer className="h-[30px] shrink-0 px-3.5 bg-[#060f1c] border-t border-sky-500/20 flex items-center justify-between text-[10.5px] z-30">
        <div className="flex items-center gap-4 min-w-0">
          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">
              CHW SUPPLY
            </span>
            <span className="font-mono-tabular font-semibold text-[#38bdf8]">
              {kpis.chwSupplyC.toFixed(1)}°C
            </span>
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">
              CHW RETURN
            </span>
            <span className="font-mono-tabular font-semibold text-[#fb923c]">
              {kpis.chwReturnC.toFixed(1)}°C
            </span>
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">ΔT</span>
            <span className="font-mono-tabular font-semibold text-[#38bdf8]">
              {kpis.deltaTK.toFixed(1)}K
            </span>
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">
              CW SUPPLY
            </span>
            <span className="font-mono-tabular font-semibold text-[#fb923c]">
              {kpis.cwSupplyC.toFixed(1)}°C
            </span>
          </div>

          <div className="hidden md:flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">
              TOWER APPROACH
            </span>
            <span className="font-mono-tabular font-semibold text-[#38bdf8]">
              {kpis.towerApproachK.toFixed(2)}K
            </span>
          </div>

          <div className="hidden md:flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">
              CHILLERS ON
            </span>
            <span className="font-mono-tabular font-semibold text-[#38bdf8]">
              {kpis.chillersOn}
            </span>
          </div>

          {/* Interactive Scenario Selector */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setScenarioOpen((o) => !o)}
              className="flex items-center gap-1.5 px-2 py-[1px] bg-[#0a1626] border border-sky-500/25 rounded-[2px] text-[10.5px] text-slate-300 hover:border-sky-400/50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <span className="text-slate-400">Scenario:</span>
              <span className="font-medium text-white">{scenario}</span>
            </button>

            {scenarioOpen && (
              <div className="absolute bottom-full left-0 mb-1 w-40 bg-[#081322] border border-sky-500/35 rounded-[3px] shadow-xl py-1 z-50">
                {SCENARIOS.map((sc) => (
                  <button
                    key={sc}
                    type="button"
                    onClick={() => handleSelectScenario(sc)}
                    className={`w-full text-left px-2.5 py-1 text-[11px] transition-colors cursor-pointer ${
                      sc === scenario
                        ? 'bg-[#0e4466] text-white font-medium'
                        : 'text-slate-300 hover:bg-sky-500/15 hover:text-white'
                    }`}
                  >
                    {sc}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="px-1.5 py-[1px] border border-sky-500/30 bg-[#081526] text-[9.5px] font-mono-tabular tracking-wider uppercase text-sky-300/80 rounded-[2px]">
            SIMULATED · NOT MEASURED
          </span>
          <span className="font-mono-tabular text-[10.5px] text-slate-500 w-10 text-right">
            {fps} fps
          </span>
        </div>
      </footer>
    </div>
  );
}

export default App;
