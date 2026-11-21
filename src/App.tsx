import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signInWithPopup, signOut, User } from 'firebase/auth';
import {
  Activity,
  AlertTriangle,
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
  RefreshCw,
} from 'lucide-react';
import { TrendsChart } from './components/TrendsChart';
import {
  createInitialDeviceGroups,
  createInitialTrends,
  INITIAL_ALARMS,
  INITIAL_KPIS,
  INITIAL_LAYER_STATE,
  SCENARIO_TARGETS,
} from './data/plantData';
import { auth, googleAuthProvider } from './lib/firebase';
import { ChillerPlantScene } from './scene/ChillerPlantScene';
import {
  AlarmEntry,
  CameraPreset,
  DataMode,
  DataQuality,
  DataSourceType,
  DeviceCategory,
  DeviceGroup,
  DeviceStatus,
  FreshnessStatus,
  LayerKey,
  LayerState,
  PlantDevice,
  PlantKpis,
  PlantSnapshotResponse,
  ProjectedLabel,
  ScenarioId,
  TrendPoint,
  UserRole,
} from './types/plant';

const DEFAULT_PLANT_CODE = 'CENTRAL_PLANT_01';

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

interface StreamPayload {
  type: 'telemetry_tick' | 'alarm_update';
  plantCode: string;
  observedAt: string;
  receivedAt: string;
  quality: DataQuality;
  isSimulated?: boolean;
  sourceType?: DataSourceType;
  scenario?: ScenarioId;
  kpis?: PlantKpis;
  deviceUpdates?: Array<{
    id: string;
    status: DeviceStatus;
    quality: DataQuality;
    loadPct: number;
    sourceTimestamp: string;
    metrics: Record<string, number | string>;
  }>;
  alarms?: AlarmEntry[];
}

function formatClock(totalSeconds: number): string {
  const sec = Math.floor(totalSeconds) % 86400;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatIsoClock(iso: string | null): string {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toISOString().slice(11, 19);
}

function formatAge(ageSec: number): string {
  if (ageSec < 60) return `${ageSec}s ago`;
  const mins = Math.floor(ageSec / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function extractNumericMetric(
  metrics: Record<string, number | string>,
  keys: string[],
  fallback: number,
): number {
  for (const key of keys) {
    const val = metrics[key];
    if (typeof val === 'number' && Number.isFinite(val)) return val;
    if (typeof val === 'string') {
      const parsed = Number(val);
      if (val !== '' && Number.isFinite(parsed)) return parsed;
    }
  }
  return fallback;
}

export function App() {
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<ChillerPlantScene | null>(null);

  // Explicit separation between live backend telemetry and local simulation demo mode
  const [dataMode, setDataMode] = useState<DataMode>('simulated');
  const [plantRole, setPlantRole] = useState<UserRole>('VIEWER');
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [backendSimulated, setBackendSimulated] = useState<boolean>(false);
  const [backendSourceType, setBackendSourceType] = useState<DataSourceType>('EDGE');
  const [staleAfterSec, setStaleAfterSec] = useState<number>(15);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Live backend hydration & stream health state
  const [snapshotLoading, setSnapshotLoading] = useState<boolean>(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [hasLiveHydrated, setHasLiveHydrated] = useState<boolean>(false);
  const [streamState, setStreamState] = useState<
    'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline'
  >('idle');
  const [trendsLoading, setTrendsLoading] = useState<boolean>(false);
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

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
  const selectedDeviceIdRef = useRef<string>('ch-1');
  selectedDeviceIdRef.current = selectedDeviceId;

  const [layers, setLayers] = useState<LayerState>(INITIAL_LAYER_STATE);
  const [alarms, setAlarms] = useState<AlarmEntry[]>(() =>
    INITIAL_ALARMS.map((a) => ({ ...a, sourceType: 'SIMULATION', state: 'ACTIVE' })),
  );
  const [kpis, setKpis] = useState<PlantKpis>(INITIAL_KPIS);
  const [trends, setTrends] = useState<TrendPoint[]>(() =>
    createInitialTrends(),
  );

  // Simulation time starting at 01:58:35 (7115s) to match reference state in demo mode
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
  const [authReady, setAuthReady] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const allDevices = useMemo(
    () => deviceGroups.flatMap((g) => g.devices),
    [deviceGroups],
  );

  const selectedDevice: PlantDevice = useMemo(() => {
    return (
      allDevices.find((d) => d.id === selectedDeviceId) ?? allDevices[0]
    );
  }, [allDevices, selectedDeviceId]);

  const totalDeviceCount = allDevices.length;

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

  // Sync 3D animation state (live mode keeps fans/flow rotating while data stays backend-driven)
  useEffect(() => {
    sceneRef.current?.setRunning(dataMode === 'live' ? true : isRunning);
  }, [isRunning, dataMode]);

  useEffect(() => {
    sceneRef.current?.setSpeedMultiplier(dataMode === 'live' ? 1 : speedMultiplier);
  }, [speedMultiplier, dataMode]);

  useEffect(() => {
    sceneRef.current?.setExplodeFactor(explodeFactor);
  }, [explodeFactor]);

  useEffect(() => {
    sceneRef.current?.setShowLabels(showLabels);
  }, [showLabels]);

  // 1-second clock ticker for freshness age calculation in live mode
  useEffect(() => {
    if (dataMode !== 'live') return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [dataMode]);

  // Listen to Firebase Auth state; automatically enter live mode on sign-in
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      setAuthReady(true);
      setAuthError(null);
      if (user) {
        setDataMode('live');
      } else {
        setHasLiveHydrated(false);
        setObservedAt(null);
        setSnapshotError(null);
        setStreamState('idle');
      }
    });
    return () => unsubscribe();
  }, []);

  // Switch between simulated and live baseline cleanly
  const handleModeChange = useCallback(
    (nextMode: DataMode) => {
      setScenarioOpen(false);
      if (nextMode === dataMode) return;
      if (nextMode === 'simulated') {
        setDataMode('simulated');
        setSnapshotError(null);
        setStreamState('idle');
        setDeviceGroups(createInitialDeviceGroups());
        setKpis(INITIAL_KPIS);
        setTrends(createInitialTrends());
        setAlarms(
          INITIAL_ALARMS.map((a) => ({
            ...a,
            sourceType: 'SIMULATION',
            state: 'ACTIVE',
          })),
        );
        setScenario('Steady State');
        setObservedAt(null);
      } else {
        setHasLiveHydrated(false);
        setTrends([]);
        setAlarms([]);
        setDataMode('live');
        setRefreshNonce((n) => n + 1);
      }
    },
    [dataMode],
  );

  // Hydrate full plant snapshot from backend in LIVE mode
  useEffect(() => {
    if (dataMode !== 'live') return;
    if (!authReady) return;
    if (!currentUser) {
      setSnapshotLoading(false);
      setStreamState('offline');
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    const hydrate = async () => {
      setSnapshotLoading(true);
      setSnapshotError(null);
      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(`/api/v1/plants/${DEFAULT_PLANT_CODE}/snapshot`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (!res.ok) {
          let errMsg = `Snapshot request failed (${res.status})`;
          try {
            const payload = (await res.json()) as { error?: { message?: string } };
            if (payload?.error?.message) errMsg = payload.error.message;
          } catch {
            // Keep default message
          }
          throw new Error(errMsg);
        }

        const snapshot = (await res.json()) as PlantSnapshotResponse;
        if (cancelled) return;

        setKpis(snapshot.kpis);
        setDeviceGroups(snapshot.deviceGroups);
        setAlarms(snapshot.alarms);
        setTrends(snapshot.trends);
        setScenario(snapshot.plant.scenario);
        setPlantRole(snapshot.plant.role);
        setObservedAt(snapshot.plant.observedAt);
        setBackendSimulated(snapshot.plant.isSimulated);
        setBackendSourceType(snapshot.plant.sourceType);
        setStaleAfterSec(snapshot.plant.staleAfterSec || 15);
        setHasLiveHydrated(true);
        setNowMs(Date.now());
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        setSnapshotError(
          err instanceof Error ? err.message : 'Unable to load live telemetry snapshot',
        );
        setHasLiveHydrated(false);
      } finally {
        if (!cancelled) setSnapshotLoading(false);
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [dataMode, authReady, currentUser, refreshNonce]);

  // Fetch device-specific trends whenever selected device changes in LIVE mode
  useEffect(() => {
    if (dataMode !== 'live' || !currentUser || !hasLiveHydrated) return;

    const controller = new AbortController();
    let cancelled = false;

    const fetchTrends = async () => {
      setTrendsLoading(true);
      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(
          `/api/v1/plants/${DEFAULT_PLANT_CODE}/devices/${encodeURIComponent(selectedDeviceId)}/trends?limit=300`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { points?: TrendPoint[] };
        if (!cancelled && Array.isArray(data.points)) {
          setTrends(data.points);
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      } finally {
        if (!cancelled) setTrendsLoading(false);
      }
    };

    void fetchTrends();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [dataMode, currentUser, hasLiveHydrated, selectedDeviceId]);

  // Real-time SSE connection with Authorization Bearer header & exponential backoff
  useEffect(() => {
    if (dataMode !== 'live' || !currentUser || !hasLiveHydrated) {
      return;
    }

    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: number | null = null;
    let activeController: AbortController | null = null;

    const handleStreamEvent = (eventName: string, rawData: string) => {
      if (eventName === 'connected') {
        setStreamState('connected');
        attempt = 0;
        return;
      }
      if (!rawData) return;

      let parsed: StreamPayload;
      try {
        parsed = JSON.parse(rawData) as StreamPayload;
      } catch {
        return;
      }

      if (parsed.type === 'telemetry_tick') {
        setObservedAt(parsed.observedAt);
        if (typeof parsed.isSimulated === 'boolean') {
          setBackendSimulated(parsed.isSimulated);
        }
        if (parsed.sourceType) {
          setBackendSourceType(parsed.sourceType);
        }
        setNowMs(Date.now());
        if (parsed.scenario) setScenario(parsed.scenario);
        if (parsed.kpis) setKpis(parsed.kpis);

        if (parsed.deviceUpdates && parsed.deviceUpdates.length > 0) {
          const updateMap = new Map(parsed.deviceUpdates.map((u) => [u.id, u]));
          setDeviceGroups((prev) =>
            prev.map((group) => ({
              ...group,
              devices: group.devices.map((dev) => {
                const upd = updateMap.get(dev.id) ?? updateMap.get(dev.deviceKey ?? '');
                if (!upd) return dev;
                return {
                  ...dev,
                  status: upd.status,
                  quality: upd.quality,
                  loadPct: upd.loadPct,
                  sourceTimestamp: upd.sourceTimestamp,
                  liveParams: dev.liveParams.map((p) => {
                    const nextVal = upd.metrics[p.label];
                    return nextVal !== undefined
                      ? { ...p, value: String(nextVal) }
                      : p;
                  }),
                };
              }),
            })),
          );

          const activeDevUpd = updateMap.get(selectedDeviceIdRef.current);
          if (activeDevUpd) {
            setTrends((prev) => {
              const last = prev[prev.length - 1];
              const nextPt: TrendPoint = {
                timeSec: (last?.timeSec ?? 0) + 1,
                recordedAt: activeDevUpd.sourceTimestamp,
                loadPct: activeDevUpd.loadPct,
                cop: extractNumericMetric(activeDevUpd.metrics, ['COP', 'cop'], last?.cop ?? 0),
                chwOut: extractNumericMetric(
                  activeDevUpd.metrics,
                  ['CHW Out', 'chwOutC'],
                  last?.chwOut ?? 0,
                ),
                cwIn: extractNumericMetric(
                  activeDevUpd.metrics,
                  ['CW In', 'cwInC'],
                  last?.cwIn ?? 0,
                ),
              };
              const updated = [...prev, nextPt];
              return updated.length > 300 ? updated.slice(updated.length - 300) : updated;
            });
          }
        }

        if (parsed.alarms && parsed.alarms.length > 0) {
          setAlarms((prev) => {
            const incomingIds = new Set(parsed.alarms!.map((a) => a.id));
            const filtered = prev.filter((a) => !incomingIds.has(a.id));
            return [...parsed.alarms!, ...filtered].slice(0, 50);
          });
        }
      } else if (parsed.type === 'alarm_update' && parsed.alarms?.length) {
        setAlarms((prev) => {
          const map = new Map(parsed.alarms!.map((a) => [a.id, a]));
          const updated = prev.map((existing) => map.get(existing.id) ?? existing);
          for (const a of parsed.alarms!) {
            if (!updated.some((item) => item.id === a.id)) {
              updated.unshift(a);
            }
          }
          return updated.slice(0, 50);
        });
      }
    };

    const connect = async () => {
      if (cancelled) return;
      activeController = new AbortController();
      setStreamState(attempt === 0 ? 'connecting' : 'reconnecting');

      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(`/api/v1/plants/${DEFAULT_PLANT_CODE}/stream`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          signal: activeController.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Stream connection failed (${res.status})`);
        }

        const recoveredFromDrop = attempt > 0;
        setStreamState('connected');
        attempt = 0;

        if (recoveredFromDrop) {
          // Rehydrate missed ticks from latest persisted snapshot after SSE reconnect
          void fetch(`/api/v1/plants/${DEFAULT_PLANT_CODE}/snapshot`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: activeController.signal,
          })
            .then((snapRes) => (snapRes.ok ? (snapRes.json() as Promise<PlantSnapshotResponse>) : null))
            .then((snap) => {
              if (!snap || cancelled) return;
              setKpis(snap.kpis);
              setDeviceGroups(snap.deviceGroups);
              setAlarms(snap.alarms);
              setScenario(snap.plant.scenario);
              setObservedAt(snap.plant.observedAt);
              setBackendSimulated(snap.plant.isSimulated);
              setBackendSourceType(snap.plant.sourceType);
              setNowMs(Date.now());
            })
            .catch(() => {
              // Next tick or manual retry will reconcile
            });
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sepIdx = buffer.indexOf('\n\n');
          while (sepIdx !== -1) {
            const block = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);

            let eventName = 'message';
            const dataLines: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) continue;
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trim());
              }
            }
            if (dataLines.length > 0) {
              handleStreamEvent(eventName, dataLines.join('\n'));
            }

            sepIdx = buffer.indexOf('\n\n');
          }
        }

        if (!cancelled) {
          throw new Error('Telemetry stream ended unexpectedly');
        }
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) {
          return;
        }
        attempt += 1;
        setStreamState(attempt >= 3 ? 'offline' : 'reconnecting');
        const delayMs = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt - 1, 4)));
        reconnectTimer = window.setTimeout(() => {
          void connect();
        }, delayMs);
      }
    };

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      activeController?.abort();
    };
  }, [dataMode, currentUser, hasLiveHydrated]);

  // Thermodynamic Simulation Tick — strictly active ONLY in explicit 'simulated' demo mode
  useEffect(() => {
    if (dataMode !== 'simulated' || !isRunning) return;

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
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [dataMode, isRunning, speedMultiplier, scenario]);

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
      if (dataMode !== 'simulated') return;
      setScenario(nextScenario);
      setScenarioOpen(false);
      const target = SCENARIO_TARGETS[nextScenario];
      const msg = `Demo scenario set: ${nextScenario} (${target.chillersOn} chillers)`;
      const severity = nextScenario === 'High Wet Bulb' ? 'WARN' : 'INFO';
      setAlarms((prev) => [
        {
          id: `sim-alm-${Date.now()}`,
          timestamp: formatClock(simSeconds),
          severity,
          state: 'ACTIVE',
          sourceType: 'SIMULATION',
          message: msg,
          source: 'Demo Simulator',
        },
        ...prev.slice(0, 14),
      ]);
    },
    [dataMode, simSeconds],
  );

  const handleAlarmAction = useCallback(
    async (alarm: AlarmEntry, action: 'acknowledge' | 'clear') => {
      if (dataMode === 'simulated') {
        setAlarms((prev) =>
          prev.map((item) =>
            item.id === alarm.id
              ? {
                  ...item,
                  state: action === 'acknowledge' ? 'ACKNOWLEDGED' : 'CLEARED',
                }
              : item,
          ),
        );
        return;
      }

      if (!currentUser || !alarm.numericId) return;
      try {
        const token = await currentUser.getIdToken();
        const res = await fetch(
          `/api/v1/plants/${DEFAULT_PLANT_CODE}/alarms/${alarm.numericId}/${action}`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { alarm?: AlarmEntry };
        if (data.alarm) {
          setAlarms((prev) =>
            prev.map((item) => (item.id === alarm.id ? data.alarm! : item)),
          );
        }
      } catch {
        // SSE or next retry will keep state aligned
      }
    },
    [dataMode, currentUser],
  );

  const handleAuthAction = useCallback(async () => {
    setAuthError(null);
    try {
      if (currentUser) {
        await signOut(auth);
      } else {
        await signInWithPopup(auth, googleAuthProvider);
      }
    } catch {
      setAuthError('Sign-in popup could not complete. Retry when ready.');
    }
  }, [currentUser]);

  const handleRetryLive = useCallback(() => {
    setRefreshNonce((n) => n + 1);
  }, []);

  // Compute dynamic Freshness Status & age label (LIVE | SIMULATED | STALE | OFFLINE | ERROR)
  const { freshnessStatus, observedAgeLabel } = useMemo((): {
    freshnessStatus: FreshnessStatus;
    observedAgeLabel: string;
  } => {
    if (dataMode === 'simulated') {
      return { freshnessStatus: 'SIMULATED', observedAgeLabel: 'LOCAL DEMO' };
    }
    if (snapshotError) {
      return {
        freshnessStatus: 'ERROR',
        observedAgeLabel: 'API ERROR',
      };
    }
    if (!currentUser || streamState === 'offline') {
      return {
        freshnessStatus: 'OFFLINE',
        observedAgeLabel: !currentUser ? 'SIGN IN REQUIRED' : 'DISCONNECTED',
      };
    }
    if (!observedAt) {
      return {
        freshnessStatus: snapshotLoading ? 'OFFLINE' : 'STALE',
        observedAgeLabel: snapshotLoading ? 'SYNCING...' : 'NO TELEMETRY',
      };
    }
    const obsMs = Date.parse(observedAt);
    const ageSec = Number.isFinite(obsMs)
      ? Math.max(0, Math.floor((nowMs - obsMs) / 1000))
      : staleAfterSec + 1;
    const isStale = ageSec > staleAfterSec || streamState === 'reconnecting';
    if (isStale) {
      return {
        freshnessStatus: 'STALE',
        observedAgeLabel: formatAge(ageSec),
      };
    }
    if (backendSimulated || backendSourceType === 'SIMULATION' || backendSourceType === 'SEED') {
      return {
        freshnessStatus: 'SIMULATED',
        observedAgeLabel:
          backendSourceType === 'SEED'
            ? `SEEDED · ${formatAge(ageSec)}`
            : `EDGE SIM · ${formatAge(ageSec)}`,
      };
    }
    return {
      freshnessStatus: 'LIVE',
      observedAgeLabel: formatAge(ageSec),
    };
  }, [
    dataMode,
    snapshotError,
    currentUser,
    streamState,
    observedAt,
    snapshotLoading,
    nowMs,
    staleAfterSec,
    backendSimulated,
    backendSourceType,
  ]);

  const latestTrend = trends[trends.length - 1] ?? {
    loadPct: 0,
    cop: 0,
    chwOut: 0,
    cwIn: 0,
  };

  const isLiveBlocked =
    dataMode === 'live' &&
    (!currentUser ||
      Boolean(snapshotError) ||
      !hasLiveHydrated ||
      freshnessStatus === 'OFFLINE' ||
      freshnessStatus === 'ERROR');
  const canOperateAlarms =
    dataMode === 'simulated' || plantRole === 'OPERATOR' || plantRole === 'ADMIN';

  const statusBadgeClass =
    freshnessStatus === 'LIVE'
      ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
      : freshnessStatus === 'STALE'
        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
        : freshnessStatus === 'OFFLINE' || freshnessStatus === 'ERROR'
          ? 'border-rose-500/50 bg-rose-500/10 text-rose-300'
          : 'border-sky-500/35 bg-[#081526] text-sky-300';

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
          <div
            className={`hidden lg:flex items-center gap-2.5 transition-opacity ${
              isLiveBlocked || freshnessStatus === 'STALE' ? 'opacity-65' : 'opacity-100'
            }`}
          >
            <div className="kpi-card px-3 py-1 min-w-[138px]">
              <div className="text-[9px] font-semibold tracking-[0.09em] uppercase text-slate-400 leading-none mb-0.5">
                COOLING LOAD
              </div>
              <div className="font-mono-tabular text-[17px] font-semibold leading-tight text-[#38bdf8]">
                {isLiveBlocked ? '—' : kpis.coolingLoadMw.toFixed(2)}
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
                {isLiveBlocked ? '—' : kpis.totalPowerMw.toFixed(2)}
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
                {isLiveBlocked ? '—' : kpis.systemCop.toFixed(2)}
              </div>
            </div>

            <div className="kpi-card px-3 py-1 min-w-[132px]">
              <div className="text-[9px] font-semibold tracking-[0.09em] uppercase text-slate-400 leading-none mb-0.5">
                WET BULB
              </div>
              <div className="font-mono-tabular text-[17px] font-semibold leading-tight text-[#c084fc]">
                {isLiveBlocked ? '—' : kpis.wetBulbC.toFixed(1)}
                <span className="text-[10px] font-normal text-slate-500 ml-1">
                  °C
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Stream/Sim State, Clock, Speed Multipliers (Demo) & Operator Auth */}
        <div className="flex items-center gap-3.5 shrink-0">
          {dataMode === 'simulated' ? (
            <button
              type="button"
              onClick={() => setIsRunning((r) => !r)}
              className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-[0.09em] uppercase text-slate-300 hover:text-white transition-colors cursor-pointer"
              title={isRunning ? 'Pause Demo Simulation' : 'Resume Demo Simulation'}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isRunning ? 'bg-emerald-400' : 'bg-amber-400'
                }`}
              />
              <span>{isRunning ? 'RUNNING' : 'PAUSED'}</span>
            </button>
          ) : (
            <div className="flex items-center gap-1.5 text-[10.5px] font-medium tracking-[0.09em] uppercase text-slate-300">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  freshnessStatus === 'LIVE'
                    ? 'bg-emerald-400'
                    : freshnessStatus === 'SIMULATED'
                      ? 'bg-sky-400'
                      : freshnessStatus === 'STALE'
                        ? 'bg-amber-400'
                        : 'bg-rose-500'
                }`}
              />
              <span>{freshnessStatus}</span>
            </div>
          )}

          <div
            className="font-mono-tabular text-[14.5px] font-semibold tracking-wider text-slate-100"
            title={
              dataMode === 'live'
                ? `Last observed sensor timestamp (UTC): ${observedAt ?? 'none'}`
                : 'Simulation clock'
            }
          >
            {dataMode === 'live' ? formatIsoClock(observedAt) : formatClock(simSeconds)}
          </div>

          {dataMode === 'simulated' && (
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
          )}

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

        {/* Non-blocking Live Connection / Error / Retry Banner */}
        {((dataMode === 'live' && (!currentUser || snapshotError || streamState === 'offline' || streamState === 'reconnecting')) ||
          authError) && (
          <div className="absolute top-2.5 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 px-3 py-1.5 bg-[#0a1526]/95 border border-amber-500/45 rounded-[3px] shadow-xl text-[11px] text-slate-200">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span>
              {authError
                ? authError
                : !currentUser
                  ? 'Live telemetry requires operator sign-in.'
                  : snapshotError
                    ? snapshotError
                    : streamState === 'offline'
                      ? 'Live stream disconnected. Readings are not live.'
                      : 'Reconnecting live telemetry stream...'}
            </span>
            {dataMode === 'live' && !currentUser ? (
              <button
                type="button"
                onClick={handleAuthAction}
                className="px-2 py-0.5 bg-[#0e4466] hover:bg-[#145985] text-white rounded-[2px] text-[10.5px] font-medium cursor-pointer"
              >
                Sign in
              </button>
            ) : (
              dataMode === 'live' && (
                <button
                  type="button"
                  onClick={handleRetryLive}
                  className="flex items-center gap-1 px-2 py-0.5 bg-[#0e4466] hover:bg-[#145985] text-white rounded-[2px] text-[10.5px] font-medium cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3" />
                  <span>Retry</span>
                </button>
              )
            )}
            {dataMode === 'live' && (
              <button
                type="button"
                onClick={() => handleModeChange('simulated')}
                className="px-2 py-0.5 border border-sky-500/30 hover:border-sky-400/60 text-slate-300 hover:text-white rounded-[2px] text-[10.5px] cursor-pointer"
              >
                Demo Mode
              </button>
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
                {totalDeviceCount} units
              </span>
            </div>

            <div className="flex-1 overflow-y-auto hud-scroll px-1.5 py-1.5 space-y-1">
              {dataMode === 'live' && snapshotLoading && !hasLiveHydrated ? (
                <div className="px-2 py-6 text-center text-[11px] font-mono-tabular text-slate-400">
                  Hydrating plant devices...
                </div>
              ) : (
                deviceGroups.map((group) => {
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
                })
              )}
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
              {alarms.length === 0 ? (
                <div className="px-2.5 py-4 text-center text-[11px] text-slate-500">
                  {dataMode === 'live' && snapshotLoading
                    ? 'Loading alarms...'
                    : 'No active or recent alarms'}
                </div>
              ) : (
                alarms.map((alm) => (
                  <div key={alm.id} className="px-2.5 py-1.5 flex items-start gap-2">
                    <span className="font-mono-tabular text-[10px] text-slate-500 shrink-0 pt-[1px]">
                      {alm.timestamp}
                    </span>
                    <div className="min-w-0 flex-1 leading-snug">
                      <div className="text-[11px] text-slate-200 truncate">
                        <span
                          className={`font-mono-tabular font-semibold mr-1 ${
                            alm.severity === 'CRIT'
                              ? 'text-rose-400'
                              : alm.severity === 'WARN'
                                ? 'text-amber-400'
                                : 'text-slate-300'
                          }`}
                        >
                          [{alm.severity}]
                        </span>
                        {alm.message}
                      </div>
                      <div className="flex items-center justify-between gap-1 text-[10px] text-slate-500 mt-0.5">
                        <span className="truncate">
                          {alm.source}
                          {alm.sourceType ? ` · ${alm.sourceType}` : ''}
                          {alm.occurrenceCount && alm.occurrenceCount > 1
                            ? ` ×${alm.occurrenceCount}`
                            : ''}
                          {alm.state && alm.state !== 'ACTIVE' ? ` · ${alm.state}` : ''}
                        </span>
                        {canOperateAlarms && alm.state !== 'CLEARED' && (
                          <span className="flex items-center gap-1 shrink-0">
                            {alm.state !== 'ACKNOWLEDGED' && (
                              <button
                                type="button"
                                onClick={() => void handleAlarmAction(alm, 'acknowledge')}
                                className="px-1 border border-sky-500/30 hover:border-sky-400/70 text-sky-300 rounded-[2px] text-[9px] cursor-pointer"
                              >
                                Ack
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleAlarmAction(alm, 'clear')}
                              className="px-1 border border-slate-600/60 hover:border-slate-400 text-slate-300 rounded-[2px] text-[9px] cursor-pointer"
                            >
                              Clr
                            </button>
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
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
              <div className="flex items-center gap-1.5 flex-wrap">
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
                {dataMode === 'live' && selectedDevice.quality && (
                  <span className="px-1.5 py-[1px] text-[9px] font-mono-tabular text-sky-300 border border-sky-500/35 bg-sky-500/10 rounded-[2px]">
                    {selectedDevice.quality}
                  </span>
                )}
              </div>

              <h3 className="text-[15px] font-semibold text-white mt-1.5 leading-tight">
                {selectedDevice.name}
              </h3>
              <div className="text-[11px] text-slate-500 mb-2">
                {selectedDevice.category}
              </div>

              <div className="text-[10.5px] font-medium text-slate-400 border-b border-sky-500/15 pb-1 mb-1.5">
                {dataMode === 'live' ? 'Measured Parameters' : 'Live Parameters'}
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
                loading={dataMode === 'live' && (snapshotLoading || trendsLoading)}
                emptyMessage={
                  dataMode === 'live' && !currentUser
                    ? 'Sign in to inspect live backend trends.'
                    : 'No telemetry samples recorded for this device yet.'
                }
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
              {isLiveBlocked ? '—' : `${kpis.chwSupplyC.toFixed(1)}°C`}
            </span>
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">
              CHW RETURN
            </span>
            <span className="font-mono-tabular font-semibold text-[#fb923c]">
              {isLiveBlocked ? '—' : `${kpis.chwReturnC.toFixed(1)}°C`}
            </span>
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">ΔT</span>
            <span className="font-mono-tabular font-semibold text-[#38bdf8]">
              {isLiveBlocked ? '—' : `${kpis.deltaTK.toFixed(1)}K`}
            </span>
          </div>

          <div className="flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">
              CW SUPPLY
            </span>
            <span className="font-mono-tabular font-semibold text-[#fb923c]">
              {isLiveBlocked ? '—' : `${kpis.cwSupplyC.toFixed(1)}°C`}
            </span>
          </div>

          <div className="hidden md:flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">
              TOWER APPROACH
            </span>
            <span className="font-mono-tabular font-semibold text-[#38bdf8]">
              {isLiveBlocked ? '—' : `${kpis.towerApproachK.toFixed(2)}K`}
            </span>
          </div>

          <div className="hidden md:flex items-center gap-1.5 whitespace-nowrap">
            <span className="text-slate-500 tracking-wider uppercase">
              CHILLERS ON
            </span>
            <span className="font-mono-tabular font-semibold text-[#38bdf8]">
              {isLiveBlocked ? '—' : kpis.chillersOn}
            </span>
          </div>

          {/* Scenario Selector (interactive in Demo mode, read-only plant regime in Live mode) */}
          <div className="relative">
            <button
              type="button"
              disabled={dataMode === 'live'}
              onClick={() => dataMode === 'simulated' && setScenarioOpen((o) => !o)}
              className={`flex items-center gap-1.5 px-2 py-[1px] bg-[#0a1626] border border-sky-500/25 rounded-[2px] text-[10.5px] text-slate-300 transition-colors whitespace-nowrap ${
                dataMode === 'simulated'
                  ? 'hover:border-sky-400/50 cursor-pointer'
                  : 'opacity-75 cursor-default'
              }`}
              title={
                dataMode === 'live'
                  ? 'Reported by live edge gateway'
                  : 'Switch simulated demo scenario'
              }
            >
              <span className="text-slate-400">Scenario:</span>
              <span className="font-medium text-white">{scenario}</span>
            </button>

            {scenarioOpen && dataMode === 'simulated' && (
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

        <div className="flex items-center gap-2.5 shrink-0">
          {/* Explicit Mode Switcher: LIVE vs SIM */}
          <div className="flex items-center border border-sky-500/25 bg-[#081220] rounded-[2px] overflow-hidden">
            <button
              type="button"
              onClick={() => handleModeChange('live')}
              className={`px-1.5 py-[1px] text-[9.5px] font-mono-tabular uppercase tracking-wider transition-colors cursor-pointer ${
                dataMode === 'live'
                  ? 'bg-[#0e4466] text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              LIVE
            </button>
            <button
              type="button"
              onClick={() => handleModeChange('simulated')}
              className={`px-1.5 py-[1px] text-[9.5px] font-mono-tabular uppercase tracking-wider transition-colors cursor-pointer ${
                dataMode === 'simulated'
                  ? 'bg-[#0e4466] text-white font-semibold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              SIM
            </button>
          </div>

          {/* Dynamic Telemetry Freshness & Connection Status Indicator */}
          <span
            className={`px-1.5 py-[1px] border text-[9.5px] font-mono-tabular tracking-wider uppercase rounded-[2px] ${statusBadgeClass}`}
            title={
              dataMode === 'live'
                ? `Last observed sensor reading: ${observedAt ?? 'none'}`
                : 'Local thermodynamic simulation active'
            }
          >
            {freshnessStatus} · {observedAgeLabel}
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
