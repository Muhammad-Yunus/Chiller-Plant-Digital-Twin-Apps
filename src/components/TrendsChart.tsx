import React, { useMemo } from 'react';
import { TrendPoint } from '../types/plant';

interface TrendsChartProps {
  points: TrendPoint[];
  currentLoad: string;
  currentCop: string;
  currentChwOut: string;
  currentCwIn: string;
  loading?: boolean;
  emptyMessage?: string;
}

const CHART_W = 228;
const CHART_H = 104;
const PAD_L = 26;
const PAD_R = 6;
const PAD_T = 8;
const PAD_B = 16;

const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

// Normalize physical HVAC metrics onto the 0–100% chart scale matching the reference curves
function normLoad(v: number): number {
  return Math.max(0, Math.min(100, v));
}
function normCop(v: number): number {
  return Math.max(0, Math.min(100, (v / 8.0) * 100));
}
function normChwOut(v: number): number {
  // 5°C–10°C -> ~40%–65% band
  return Math.max(0, Math.min(100, 35 + ((v - 5.0) / 5.0) * 35));
}
function normCwIn(v: number): number {
  // 25°C–38°C -> ~30%–80% band
  return Math.max(0, Math.min(100, 25 + ((v - 25.0) / 13.0) * 80));
}

function buildPath(
  points: TrendPoint[],
  maxSlots: number,
  extractor: (p: TrendPoint) => number,
): string {
  if (points.length === 0) return '';
  const visible = points.slice(-maxSlots);
  const startSlot = maxSlots - visible.length;

  return visible
    .map((p, idx) => {
      const slot = startSlot + idx;
      const x = PAD_L + (slot / Math.max(1, maxSlots - 1)) * PLOT_W;
      const pct = extractor(p);
      const y = PAD_T + (1 - pct / 100) * PLOT_H;
      return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export const TrendsChart: React.FC<TrendsChartProps> = ({
  points,
  currentLoad,
  currentCop,
  currentChwOut,
  currentCwIn,
  loading = false,
  emptyMessage,
}) => {
  const maxSlots = 300; // 5 minutes at 1 Hz

  const paths = useMemo(() => {
    return {
      load: buildPath(points, maxSlots, (p) => normLoad(p.loadPct)),
      cop: buildPath(points, maxSlots, (p) => normCop(p.cop)),
      chwOut: buildPath(points, maxSlots, (p) => normChwOut(p.chwOut)),
      cwIn: buildPath(points, maxSlots, (p) => normCwIn(p.cwIn)),
    };
  }, [points]);

  const yTicks = [100, 75, 50, 25, 0];

  if (loading && points.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-[11px] font-mono-tabular text-slate-400">
        Loading device trend history...
      </div>
    );
  }

  if (!loading && points.length === 0) {
    return (
      <div className="flex flex-col h-full items-center justify-center text-center px-2 text-[11px] text-slate-400">
        {emptyMessage ?? 'No telemetry samples recorded for this unit yet.'}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full justify-between">
      <div className="w-full">
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="w-full h-auto block overflow-visible"
          aria-label="Live Plant Trends Chart"
        >
          {/* Horizontal gridlines & Y-axis labels */}
          {yTicks.map((tick) => {
            const y = PAD_T + (1 - tick / 100) * PLOT_H;
            return (
              <g key={tick}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={CHART_W - PAD_R}
                  y2={y}
                  stroke="rgba(56, 189, 248, 0.12)"
                  strokeWidth="0.75"
                />
                <text
                  x={PAD_L - 4}
                  y={y + 2.8}
                  textAnchor="end"
                  fill="#475569"
                  fontSize="7.5"
                  fontFamily="var(--font-mono)"
                >
                  {tick}%
                </text>
              </g>
            );
          })}

          {/* Vertical subtle reference ticks */}
          {[0, 0.5, 1].map((frac, i) => {
            const x = PAD_L + frac * PLOT_W;
            return (
              <line
                key={i}
                x1={x}
                y1={PAD_T}
                x2={x}
                y2={PAD_T + PLOT_H}
                stroke="rgba(56, 189, 248, 0.08)"
                strokeWidth="0.75"
              />
            );
          })}

          {/* X-axis labels */}
          <text
            x={PAD_L}
            y={CHART_H - 3}
            textAnchor="start"
            fill="#475569"
            fontSize="7.5"
            fontFamily="var(--font-mono)"
          >
            -5m
          </text>
          <text
            x={PAD_L + PLOT_W * 0.5}
            y={CHART_H - 3}
            textAnchor="middle"
            fill="#475569"
            fontSize="7.5"
            fontFamily="var(--font-mono)"
          >
            -2.5m
          </text>
          <text
            x={CHART_W - PAD_R}
            y={CHART_H - 3}
            textAnchor="end"
            fill="#475569"
            fontSize="7.5"
            fontFamily="var(--font-mono)"
          >
            now
          </text>

          {/* Trend Curves */}
          <path
            d={paths.cwIn}
            fill="none"
            stroke="#a855f7"
            strokeWidth="1.35"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={paths.chwOut}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="1.35"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={paths.cop}
            fill="none"
            stroke="#34d399"
            strokeWidth="1.35"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={paths.load}
            fill="none"
            stroke="#22d3ee"
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </div>

      {/* 2-Row Compact Telemetry Legend */}
      <div className="pt-1.5 border-t border-sky-500/10 flex flex-col gap-1 text-[10.5px] leading-tight">
        <div className="flex items-center flex-wrap gap-x-3 gap-y-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-[2px] bg-[#22d3ee]" />
            <span className="text-slate-400">Load</span>
            <span className="font-mono-tabular font-semibold text-slate-100">
              {currentLoad}%
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-[2px] bg-[#34d399]" />
            <span className="text-slate-400">COP</span>
            <span className="font-mono-tabular font-semibold text-slate-100">
              {currentCop}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-2 h-[2px] bg-[#f59e0b]" />
            <span className="text-slate-400">CHW Out</span>
            <span className="font-mono-tabular font-semibold text-slate-100">
              {currentChwOut}°C
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-block w-2 h-[2px] bg-[#a855f7]" />
          <span className="text-slate-400">CW In</span>
          <span className="font-mono-tabular font-semibold text-slate-100">
            {currentCwIn}°C
          </span>
        </div>
      </div>
    </div>
  );
};
