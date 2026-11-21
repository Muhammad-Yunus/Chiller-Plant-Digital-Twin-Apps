import { EventEmitter } from 'events';
import type {
  AlarmEntry,
  DataQuality,
  DataSourceType,
  DeviceStatus,
  PlantKpis,
  ScenarioId,
} from '../types/plant.ts';

export interface PlantTelemetryStreamEvent {
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

class PlantRealtimeBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  subscribe(plantId: number, listener: (event: PlantTelemetryStreamEvent) => void): () => void {
    const channel = `plant:${plantId}`;
    this.emitter.on(channel, listener);
    return () => {
      this.emitter.off(channel, listener);
    };
  }

  publish(plantId: number, event: PlantTelemetryStreamEvent): void {
    this.emitter.emit(`plant:${plantId}`, event);
  }
}

export const realtimeBus = new PlantRealtimeBus();
