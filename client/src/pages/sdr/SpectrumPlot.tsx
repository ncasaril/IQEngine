import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
  height?: number;
  onConfig?: (cfg: SpectrumConfig) => void;
  onStatus?: (status: string) => void;
  /** Called when user clicks a frequency on the plot (Hz absolute). */
  onClickFrequency?: (hz: number) => void;
  /** Called periodically with the currently-hovered (freq, dB) under the cursor. */
  onCursorReadout?: (info: { hz: number; db: number } | null) => void;
  /** Bumping this value resets the max-hold trace. */
  maxHoldResetKey?: number;
}

const GRID_COLOR = 'rgba(255,255,255,0.08)';
const AXIS_COLOR = 'rgba(255,255,255,0.45)';
const LIVE_COLOR = '#4ade80';   // green-400
const MAX_HOLD_COLOR = '#f97316'; // orange-500
const PAUSE_COLOR = '#60a5fa';  // blue-400

export function SpectrumPlot({
  active,
  fftSize = 4096,
  frameRate = 10,
  refOffsetDb = 0,
  minDb = -100,
  maxDb = 0,
  maxHold = false,
  paused = false,
  height = 240,
  onConfig,
  onStatus,
  onClickFrequency,
  onCursorReadout,
  maxHoldResetKey = 0,
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
    const url = `${proto}//${window.location.host}/api/sdr/monitor/spectrum?fft_size=${fftSize}&frame_rate=${frameRate}`;
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
        const frame = new Float32Array(ev.data);
        pendingMetaRef.current = null;
        latestFrameRef.current = frame;
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
  }, [active, fftSize, frameRate, onConfig, onStatus]);

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
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [minDb, maxDb, refOffsetDb, maxHold, paused]);

  // Resize the canvas buffer to match its CSS pixel size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const setSize = () => {
      const dpr = window.devicePixelRatio || 1;
      const cw = canvas.clientWidth;
      canvas.width = Math.floor(cw * dpr);
      canvas.height = Math.floor(height * dpr);
    };
    setSize();
    const ro = new ResizeObserver(setSize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [height]);

  const frameToHz = useCallback(
    (pxX: number, canvasW: number) => {
      const cfg = configRef.current;
      if (!cfg) return 0;
      const frac = Math.max(0, Math.min(1, pxX / canvasW));
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
      const hz = frameToHz(x, rect.width);
      // Report dB at the cursor's frequency bin using the latest frame
      const cfg = configRef.current;
      const frame = paused && pausedFrameRef.current ? pausedFrameRef.current : latestFrameRef.current;
      if (cfg && frame) {
        const bin = Math.max(0, Math.min(cfg.fft_size - 1, Math.round((x / rect.width) * cfg.fft_size)));
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
  }
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width;
  const h = canvas.height;
  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, w, h);

  const { config, live, maxHold, minDb, maxDb, refOffsetDb, paused } = opts;

  // dB -> Y (inverted: higher dB = top)
  const span = Math.max(1, maxDb - minDb);
  const dbToY = (db: number) => {
    const t = (db - minDb) / span;
    return Math.round((1 - Math.max(0, Math.min(1, t))) * h);
  };

  // Grid
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  // Horizontal grid every 10 dB
  const step = 10;
  const firstDb = Math.ceil(minDb / step) * step;
  for (let db = firstDb; db <= maxDb; db += step) {
    const y = dbToY(db);
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  // Vertical grid: 10 divisions
  for (let i = 1; i < 10; i++) {
    const x = Math.round((i / 10) * w);
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  ctx.stroke();

  // Axis text
  ctx.font = `${10 * dpr}px ui-monospace, monospace`;
  ctx.fillStyle = AXIS_COLOR;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  for (let db = firstDb; db <= maxDb; db += step) {
    const y = dbToY(db);
    ctx.fillText(`${db} dB`, 4 * dpr, Math.min(y + 2 * dpr, h - 12 * dpr));
  }
  if (config) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let i = 0; i <= 10; i++) {
      const frac = i / 10;
      const x = Math.round(frac * w);
      const hz = config.center_freq_hz + (frac - 0.5) * config.sample_rate_hz;
      const label = `${(hz / 1e6).toFixed(3)}`;
      ctx.fillText(label, x, h - 2 * dpr);
    }
  }

  // Trace helper
  const drawTrace = (data: Float32Array, color: string, lineWidth: number) => {
    if (!data || data.length === 0) return;
    const n = data.length;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth * dpr;
    ctx.beginPath();
    // Downsample to canvas width by taking max dB in each column bucket (classic peak-hold pixel)
    const cols = Math.floor(w);
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
      if (col === 0) ctx.moveTo(col, y);
      else ctx.lineTo(col, y);
    }
    ctx.stroke();
  };

  if (maxHold) drawTrace(maxHold, MAX_HOLD_COLOR, 1);
  if (live) drawTrace(live, paused ? PAUSE_COLOR : LIVE_COLOR, 1.5);
}
