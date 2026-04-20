import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PLOT_MARGIN_LEFT,
  PLOT_MARGIN_RIGHT,
  PLOT_MARGIN_TOP,
  PLOT_MARGIN_BOTTOM,
} from './plot-geometry';

export interface SpectrumConfig {
  session_id: string;
  fft_size: number;
  frame_rate: number;
  center_freq_hz: number;
  sample_rate_hz: number;
  bin_hz: number;
  rolling_window_s: number;
  fft_shifted: boolean;
}

interface Props {
  active: boolean;
  fftSize?: number;
  frameRate?: number;
  /** Reference offset added to every dB value (used as a rough calibration to dBm) */
  refOffsetDb?: number;
  /** Y-axis bottom / top in dB (after offset applied) */
  minDb?: number;
  maxDb?: number;
  maxHold?: boolean;
  paused?: boolean;
  /** Notch the DC bins to hide the LO leakage spike. Applied server-side. */
  dcRemove?: boolean;
  height?: number;
  onConfig?: (cfg: SpectrumConfig) => void;
  onStatus?: (status: string) => void;
  /** Called when user clicks a frequency on the plot (Hz absolute). */
  onClickFrequency?: (hz: number) => void;
  /** Called periodically with the currently-hovered (freq, dB) under the cursor. */
  onCursorReadout?: (info: { hz: number; db: number } | null) => void;
  /** Bumping this value resets the max-hold trace. */
  maxHoldResetKey?: number;
  /** Draw a semi-transparent channel overlay at this absolute frequency. */
  channelCenterHz?: number | null;
  /** Channel bandwidth to shade. */
  channelBandwidthHz?: number;
}

const GRID_COLOR = 'rgba(255,255,255,0.08)';
const AXIS_COLOR = 'rgba(255,255,255,0.55)';
const LIVE_COLOR = '#4ade80';   // green-400
const MAX_HOLD_COLOR = '#f97316'; // orange-500
const PAUSE_COLOR = '#60a5fa';  // blue-400

// Re-export margins under short names for local use
const MARGIN_LEFT = PLOT_MARGIN_LEFT;
const MARGIN_RIGHT = PLOT_MARGIN_RIGHT;
const MARGIN_TOP = PLOT_MARGIN_TOP;
const MARGIN_BOTTOM = PLOT_MARGIN_BOTTOM;

export function SpectrumPlot({
  active,
  fftSize = 4096,
  frameRate = 10,
  refOffsetDb = 0,
  minDb = -100,
  maxDb = 0,
  maxHold = false,
  paused = false,
  dcRemove = false,
  height = 240,
  onConfig,
  onStatus,
  onClickFrequency,
  onCursorReadout,
  maxHoldResetKey = 0,
  channelCenterHz = null,
  channelBandwidthHz = 15_000,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingMetaRef = useRef<any>(null);
  const latestFrameRef = useRef<Float32Array | null>(null);
  const maxHoldRef = useRef<Float32Array | null>(null);
  const pausedFrameRef = useRef<Float32Array | null>(null);
  const configRef = useRef<SpectrumConfig | null>(null);
  const [config, setConfig] = useState<SpectrumConfig | null>(null);
  const [connected, setConnected] = useState(false);
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number } | null>(null);

  // Reset max-hold when caller bumps the reset key or fft_size changes
  useEffect(() => {
    maxHoldRef.current = null;
  }, [maxHoldResetKey, fftSize]);

  // Capture the live trace at the moment we paused so it stays visible
  useEffect(() => {
    if (paused && latestFrameRef.current) {
      pausedFrameRef.current = new Float32Array(latestFrameRef.current);
    } else if (!paused) {
      pausedFrameRef.current = null;
    }
  }, [paused]);

  // WebSocket connection — reconnects when active/fftSize/frameRate change
  useEffect(() => {
    if (!active) {
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
      onStatus?.('Monitor not running');
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/api/sdr/monitor/spectrum?fft_size=${fftSize}&frame_rate=${frameRate}&dc_remove=${dcRemove ? 1 : 0}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      onStatus?.('Connected');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'config') {
          const cfg = msg as SpectrumConfig;
          configRef.current = cfg;
          setConfig(cfg);
          onConfig?.(cfg);
          onStatus?.(`Live — ${(cfg.center_freq_hz / 1e6).toFixed(3)} MHz`);
        } else if (msg.type === 'frame') {
          pendingMetaRef.current = msg;
        } else if (msg.type === 'stopped') {
          onStatus?.('Monitor stopped');
          setConnected(false);
        } else if (msg.type === 'error') {
          onStatus?.(`Error: ${msg.error}`);
        }
      } else if (ev.data instanceof ArrayBuffer && pendingMetaRef.current) {
        const meta = pendingMetaRef.current;
        const frame = new Float32Array(ev.data);
        pendingMetaRef.current = null;
        latestFrameRef.current = frame;
        // Frames carry the current monitor center/sample_rate — on retune the backend
        // updates these without re-sending a `config` message, so pick them up here
        // to keep onConfig/onStatus consumers (e.g. the "Live N MHz" pill, demod offset
        // display) in sync with the actual tuning.
        const cfg = configRef.current;
        if (cfg && (cfg.center_freq_hz !== meta.center_freq_hz || cfg.sample_rate_hz !== meta.sample_rate_hz)) {
          const updated: SpectrumConfig = {
            ...cfg,
            center_freq_hz: meta.center_freq_hz,
            sample_rate_hz: meta.sample_rate_hz,
            bin_hz: meta.sample_rate_hz / cfg.fft_size,
          };
          configRef.current = updated;
          setConfig(updated);
          onConfig?.(updated);
          onStatus?.(`Live — ${(updated.center_freq_hz / 1e6).toFixed(3)} MHz`);
        }
        // Update max-hold (in raw dB — offset is applied at draw time)
        const prev = maxHoldRef.current;
        if (!prev || prev.length !== frame.length) {
          maxHoldRef.current = new Float32Array(frame);
        } else {
          for (let i = 0; i < frame.length; i++) {
            if (frame[i] > prev[i]) prev[i] = frame[i];
          }
        }
      }
    };
    ws.onerror = () => {
      onStatus?.('WebSocket error');
      setConnected(false);
    };
    ws.onclose = () => {
      setConnected(false);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [active, fftSize, frameRate, dcRemove, onConfig, onStatus]);

  // Draw loop — RAF-paced so React doesn't re-render per frame
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      if (canvas) drawSpectrum(canvas, {
        config: configRef.current,
        live: paused && pausedFrameRef.current ? pausedFrameRef.current : latestFrameRef.current,
        maxHold: maxHold ? maxHoldRef.current : null,
        minDb,
        maxDb,
        refOffsetDb,
        paused,
        channelCenterHz,
        channelBandwidthHz,
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [minDb, maxDb, refOffsetDb, maxHold, paused, channelCenterHz, channelBandwidthHz]);

  // Resize the canvas buffer to match its CSS pixel size.
  // Only touch width/height if they actually changed (HTML canvas clears the bitmap on any
  // width/height assignment, so unconditional resize produced a flash during user-driven resizes).
  // After any real resize we immediately redraw from the last frame so no blank frames sneak through.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const setSize = () => {
      const dpr = window.devicePixelRatio || 1;
      const desiredW = Math.floor(canvas.clientWidth * dpr);
      const desiredH = Math.floor(height * dpr);
      if (canvas.width !== desiredW || canvas.height !== desiredH) {
        canvas.width = desiredW;
        canvas.height = desiredH;
        drawSpectrum(canvas, {
          config: configRef.current,
          live: paused && pausedFrameRef.current ? pausedFrameRef.current : latestFrameRef.current,
          maxHold: maxHold ? maxHoldRef.current : null,
          minDb,
          maxDb,
          refOffsetDb,
          paused,
          channelCenterHz,
          channelBandwidthHz,
        });
      }
    };
    setSize();
    const ro = new ResizeObserver(setSize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [height, paused, maxHold, minDb, maxDb, refOffsetDb, channelCenterHz, channelBandwidthHz]);

  const frameToHz = useCallback(
    (pxX: number, canvasW: number) => {
      const cfg = configRef.current;
      if (!cfg) return 0;
      const plotL = MARGIN_LEFT;
      const plotW = Math.max(1, canvasW - MARGIN_LEFT - MARGIN_RIGHT);
      const frac = Math.max(0, Math.min(1, (pxX - plotL) / plotW));
      return cfg.center_freq_hz + (frac - 0.5) * cfg.sample_rate_hz;
    },
    []
  );

  const handleMove = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      setHoverPx({ x, y });
      // Bail out of readouts outside the plot area
      const plotL = MARGIN_LEFT;
      const plotW = Math.max(1, rect.width - MARGIN_LEFT - MARGIN_RIGHT);
      if (x < plotL || x > plotL + plotW) {
        onCursorReadout?.(null);
        return;
      }
      const hz = frameToHz(x, rect.width);
      const cfg = configRef.current;
      const frame = paused && pausedFrameRef.current ? pausedFrameRef.current : latestFrameRef.current;
      if (cfg && frame) {
        const bin = Math.max(0, Math.min(cfg.fft_size - 1, Math.round(((x - plotL) / plotW) * cfg.fft_size)));
        onCursorReadout?.({ hz, db: frame[bin] + refOffsetDb });
      }
    },
    [frameToHz, onCursorReadout, refOffsetDb, paused]
  );

  const handleLeave = useCallback(() => {
    setHoverPx(null);
    onCursorReadout?.(null);
  }, [onCursorReadout]);

  const handleClick = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onClickFrequency) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      onClickFrequency(frameToHz(ev.clientX - rect.left, rect.width));
    },
    [onClickFrequency, frameToHz]
  );

  const statusBadge = useMemo(() => {
    if (paused) return { label: 'PAUSED', color: PAUSE_COLOR };
    if (connected) return { label: 'LIVE', color: LIVE_COLOR };
    return { label: 'OFFLINE', color: '#6b7280' };
  }, [paused, connected]);

  return (
    <div className="relative select-none">
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height }}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        onClick={handleClick}
        className="bg-black cursor-crosshair"
      />
      <div className="absolute top-1 left-2 text-[10px] tracking-wider" style={{ color: statusBadge.color }}>
        {statusBadge.label}
      </div>
      {config && (
        <div className="absolute top-1 right-2 text-[10px] opacity-70">
          FFT {config.fft_size} · {frameRate}Hz · {(config.sample_rate_hz / 1e6).toFixed(3)} Msps
        </div>
      )}
      {hoverPx && (
        <div
          className="absolute text-[10px] bg-black/70 text-white px-1 py-0.5 pointer-events-none"
          style={{ left: Math.min(hoverPx.x + 6, 9999), top: Math.max(hoverPx.y - 18, 0) }}
        />
      )}
    </div>
  );
}

function drawSpectrum(
  canvas: HTMLCanvasElement,
  opts: {
    config: SpectrumConfig | null;
    live: Float32Array | null;
    maxHold: Float32Array | null;
    minDb: number;
    maxDb: number;
    refOffsetDb: number;
    paused: boolean;
    channelCenterHz?: number | null;
    channelBandwidthHz?: number;
  }
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width;
  const h = canvas.height;

  const mL = MARGIN_LEFT * dpr;
  const mR = MARGIN_RIGHT * dpr;
  const mT = MARGIN_TOP * dpr;
  const mB = MARGIN_BOTTOM * dpr;
  const plotL = mL;
  const plotR = w - mR;
  const plotT = mT;
  const plotB = h - mB;
  const plotW = Math.max(1, plotR - plotL);
  const plotH = Math.max(1, plotB - plotT);

  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, w, h);

  const { config, live, maxHold, minDb, maxDb, refOffsetDb, paused } = opts;
  const span = Math.max(1, maxDb - minDb);
  const dbToY = (db: number) => {
    const t = (db - minDb) / span;
    return plotT + Math.round((1 - Math.max(0, Math.min(1, t))) * plotH);
  };

  // Grid
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  const step = 10;
  const firstDb = Math.ceil(minDb / step) * step;
  for (let db = firstDb; db <= maxDb; db += step) {
    const y = dbToY(db);
    ctx.moveTo(plotL, y);
    ctx.lineTo(plotR, y);
  }
  for (let i = 1; i < 10; i++) {
    const x = plotL + Math.round((i / 10) * plotW);
    ctx.moveTo(x, plotT);
    ctx.lineTo(x, plotB);
  }
  ctx.stroke();

  // Axis text
  ctx.font = `${10 * dpr}px ui-monospace, monospace`;
  ctx.fillStyle = AXIS_COLOR;
  // dB labels — right-aligned in the left margin
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let db = firstDb; db <= maxDb; db += step) {
    const y = dbToY(db);
    ctx.fillText(`${db}`, plotL - 4 * dpr, y);
  }
  if (config) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 10; i++) {
      const frac = i / 10;
      const x = plotL + Math.round(frac * plotW);
      const hz = config.center_freq_hz + (frac - 0.5) * config.sample_rate_hz;
      ctx.fillText(`${(hz / 1e6).toFixed(3)}`, x, plotB + 2 * dpr);
    }
  }

  // Channel overlay (drawn before traces, behind them)
  if (config && opts.channelCenterHz != null && opts.channelBandwidthHz) {
    const bw = opts.channelBandwidthHz;
    const fracL = (opts.channelCenterHz - bw / 2 - (config.center_freq_hz - config.sample_rate_hz / 2)) / config.sample_rate_hz;
    const fracR = (opts.channelCenterHz + bw / 2 - (config.center_freq_hz - config.sample_rate_hz / 2)) / config.sample_rate_hz;
    const xL = plotL + Math.max(0, Math.min(plotW, fracL * plotW));
    const xR = plotL + Math.max(0, Math.min(plotW, fracR * plotW));
    const xC = plotL + Math.max(0, Math.min(plotW, ((opts.channelCenterHz - (config.center_freq_hz - config.sample_rate_hz / 2)) / config.sample_rate_hz) * plotW));
    ctx.fillStyle = 'rgba(250, 204, 21, 0.12)'; // amber-300 12%
    ctx.fillRect(xL, plotT, Math.max(1, xR - xL), plotH);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.6)';
    ctx.lineWidth = 1 * dpr;
    ctx.beginPath();
    ctx.moveTo(xC, plotT);
    ctx.lineTo(xC, plotB);
    ctx.stroke();
  }

  // Clip traces to the plot area
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotL, plotT, plotW, plotH);
  ctx.clip();

  const drawTrace = (data: Float32Array, color: string, lineWidth: number) => {
    if (!data || data.length === 0) return;
    const n = data.length;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * dpr;
    ctx.beginPath();
    const cols = Math.floor(plotW);
    const binsPerCol = n / cols;
    for (let col = 0; col < cols; col++) {
      const start = Math.floor(col * binsPerCol);
      const end = Math.min(n, Math.floor((col + 1) * binsPerCol));
      let peak = -Infinity;
      for (let i = start; i < end; i++) {
        if (data[i] > peak) peak = data[i];
      }
      if (!isFinite(peak)) continue;
      const y = dbToY(peak + refOffsetDb);
      const x = plotL + col;
      if (col === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  if (maxHold) drawTrace(maxHold, MAX_HOLD_COLOR, 1);
  if (live) drawTrace(live, paused ? PAUSE_COLOR : LIVE_COLOR, 1.5);

  ctx.restore();
}
