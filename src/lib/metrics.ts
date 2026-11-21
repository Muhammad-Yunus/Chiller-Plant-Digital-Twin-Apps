export interface OperationalMetrics {
  httpRequestsTotal: number;
  httpErrorsTotal: number;
  ingestRequestsTotal: number;
  ingestErrorsTotal: number;
  ingestDeduplicatedTotal: number;
  ingestSamplesTotal: number;
  activeSseClients: number;
  lastIngestLatencyMs: number;
  uptimeSec: number;
}

class MetricsRegistry {
  private startedAt = Date.now();
  private httpRequestsTotal = 0;
  private httpErrorsTotal = 0;
  private ingestRequestsTotal = 0;
  private ingestErrorsTotal = 0;
  private ingestDeduplicatedTotal = 0;
  private ingestSamplesTotal = 0;
  private activeSseClients = 0;
  private lastIngestLatencyMs = 0;

  incHttpRequest(statusCode: number) {
    this.httpRequestsTotal += 1;
    if (statusCode >= 500) {
      this.httpErrorsTotal += 1;
    }
  }

  recordIngestSuccess(samples: number, latencyMs: number, deduplicated: boolean) {
    this.ingestRequestsTotal += 1;
    this.lastIngestLatencyMs = latencyMs;
    if (deduplicated) {
      this.ingestDeduplicatedTotal += 1;
    } else {
      this.ingestSamplesTotal += samples;
    }
  }

  recordIngestError(latencyMs: number) {
    this.ingestRequestsTotal += 1;
    this.ingestErrorsTotal += 1;
    this.lastIngestLatencyMs = latencyMs;
  }

  incSseClients(delta: 1 | -1) {
    this.activeSseClients = Math.max(0, this.activeSseClients + delta);
  }

  snapshot(): OperationalMetrics {
    return {
      httpRequestsTotal: this.httpRequestsTotal,
      httpErrorsTotal: this.httpErrorsTotal,
      ingestRequestsTotal: this.ingestRequestsTotal,
      ingestErrorsTotal: this.ingestErrorsTotal,
      ingestDeduplicatedTotal: this.ingestDeduplicatedTotal,
      ingestSamplesTotal: this.ingestSamplesTotal,
      activeSseClients: this.activeSseClients,
      lastIngestLatencyMs: this.lastIngestLatencyMs,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}

export const metrics = new MetricsRegistry();
