import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export type DemodMode = 'nfm' | 'wfm' | 'am' | 'usb' | 'lsb';

export interface DemodState {
  mode: DemodMode;
  centerHz: number;
  bandwidthHz: number;
  volumeDb: number;
  muted: boolean;
  enabled: boolean;
}

interface Props {
  active: boolean;                // parent monitor running
  demod: DemodState;
  onChange: (d: Partial<DemodState>) => void;
  monitorCenterHz?: number;
  monitorSampleRateHz?: number;
}

const MODE_OPTIONS: { value: DemodMode; label: string; defaultBandwidth: number }[] = [
  { value: 'nfm', label: 'NFM', defaultBandwidth: 15_000 },
  { value: 'wfm', label: 'WFM', defaultBandwidth: 200_000 },
  { value: 'am', label: 'AM', defaultBandwidth: 10_000 },
  { value: 'usb', label: 'USB', defaultBandwidth: 3_000 },
  { value: 'lsb', label: 'LSB', defaultBandwidth: 3_000 },
];

export function DemodPlayer({ active, demod, onChange, monitorCenterHz, monitorSampleRateHz }: Props) {
  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef<number>(0);
  const metaRef = useRef<any>(null);
  const [status, setStatus] = useState<string>('stopped');
  const [queuedMs, setQueuedMs] = useState(0);

  // Latest demod state kept in a ref so the receive handler can call back without stale closure
  const demodRef = useRef(demod);
  useEffect(() => { demodRef.current = demod; }, [demod]);

  const ensureAudio = useCallback(async () => {
    if (!audioCtxRef.current) {
      // 48 kHz required for pcm_s16le from the backend
      audioCtxRef.current = new AudioContext({ sampleRate: 48_000 });
    }
    const ctx = audioCtxRef.current;
    if (ctx.state === 'suspended') await ctx.resume();
    return ctx;
  }, []);

  const openWs = useCallback(() => {
    if (wsRef.current) wsRef.current.close();
    const d = demodRef.current;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const qs = new URLSearchParams({
      mode: d.mode,
      center_hz: String(d.centerHz),
      bandwidth_hz: String(d.bandwidthHz),
      volume_db: String(d.volumeDb),
    }).toString();
    const ws = new WebSocket(`${proto}//${window.location.host}/api/sdr/monitor/audio?${qs}`);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => setStatus('streaming');
    ws.onclose = () => { if (wsRef.current === ws) setStatus('closed'); };
    ws.onerror = () => setStatus('error');
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'config' || msg.type === 'audio') {
          metaRef.current = msg;
        } else if (msg.type === 'error') {
          setStatus(`error: ${msg.error}`);
        } else if (msg.type === 'stopped') {
          setStatus('monitor stopped');
        }
      } else if (ev.data instanceof ArrayBuffer && metaRef.current?.type === 'audio') {
        playPcmChunk(new Int16Array(ev.data));
      }
    };
  }, []);

  const playPcmChunk = useCallback((pcm: Int16Array) => {
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    // Convert int16 → float32 in [-1, 1]
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    const buf = ctx.createBuffer(1, f.length, 48_000);
    buf.copyToChannel(f, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (demodRef.current.muted) {
      // Skip scheduling silently-muted chunks
      nextStartRef.current = ctx.currentTime;
      return;
    }
    src.connect(ctx.destination);

    const now = ctx.currentTime;
    // If we fell behind, reset the timeline so audio resumes from now+small buffer
    const minStart = now + 0.05;
    if (nextStartRef.current < minStart) nextStartRef.current = minStart;
    // Cap queued audio at ~400 ms — drop everything past that (avoid monotonically-growing latency)
    const maxQueued = 0.4;
    if (nextStartRef.current - now > maxQueued) {
      // drop this chunk
      return;
    }
    src.start(nextStartRef.current);
    nextStartRef.current += buf.duration;
    setQueuedMs(Math.round((nextStartRef.current - now) * 1000));
  }, []);

  const closeWs = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    nextStartRef.current = 0;
    setStatus('stopped');
    setQueuedMs(0);
  }, []);

  // Open/close the stream when enabled toggles or monitor starts/stops
  useEffect(() => {
    if (active && demod.enabled) {
      ensureAudio().then(openWs);
    } else {
      closeWs();
    }
    return () => { closeWs(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, demod.enabled]);

  // Send incremental control updates when config changes (without reconnecting)
  useEffect(() => {
    if (!demod.enabled || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: 'set',
      mode: demod.mode,
      center_hz: demod.centerHz,
      bandwidth_hz: demod.bandwidthHz,
      volume_db: demod.volumeDb,
      muted: demod.muted,
    }));
  }, [demod.mode, demod.centerHz, demod.bandwidthHz, demod.volumeDb, demod.muted, demod.enabled]);

  const statusPill = useMemo(() => {
    if (!demod.enabled) return { color: '#6b7280', label: 'OFF' };
    if (status === 'streaming') return { color: '#4ade80', label: 'PLAYING' };
    if (status.startsWith('error')) return { color: '#f87171', label: status };
    return { color: '#60a5fa', label: status.toUpperCase() };
  }, [demod.enabled, status]);

  const shiftHz = demod.centerHz - (monitorCenterHz ?? 0);

  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex gap-1">
        <button
          className={`btn btn-xs flex-1 ${demod.enabled ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => onChange({ enabled: !demod.enabled })}
          disabled={!active}
        >
          {demod.enabled ? 'On' : 'Off'}
        </button>
        <button
          className={`btn btn-xs flex-1 ${demod.muted ? 'btn-warning' : 'btn-ghost'}`}
          onClick={() => onChange({ muted: !demod.muted })}
        >
          {demod.muted ? 'Muted' : 'Audible'}
        </button>
      </div>
      <label className="flex flex-col">
        <span className="opacity-70">Mode</span>
        <select
          className="select select-bordered select-sm w-full"
          value={demod.mode}
          onChange={(e) => {
            const mode = e.target.value as DemodMode;
            const opt = MODE_OPTIONS.find((o) => o.value === mode);
            onChange({ mode, bandwidthHz: opt?.defaultBandwidth ?? demod.bandwidthHz });
          }}
        >
          {MODE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col">
        <span className="opacity-70">Tune (MHz) · offset {(shiftHz / 1e3).toFixed(1)} kHz</span>
        <input
          type="number"
          step="0.001"
          className="input input-bordered input-sm w-full"
          value={(demod.centerHz / 1e6).toFixed(3)}
          onChange={(e) => onChange({ centerHz: parseFloat(e.target.value) * 1e6 })}
        />
      </label>
      <label className="flex flex-col">
        <span className="opacity-70">Bandwidth (kHz)</span>
        <input
          type="number"
          step="1"
          min="1"
          className="input input-bordered input-sm w-full"
          value={(demod.bandwidthHz / 1e3).toFixed(1)}
          onChange={(e) => onChange({ bandwidthHz: Math.max(100, parseFloat(e.target.value) * 1e3) })}
        />
      </label>
      <label className="flex flex-col">
        <span className="opacity-70">Volume: {demod.volumeDb.toFixed(0)} dB</span>
        <input
          type="range"
          min={-40}
          max={20}
          step={1}
          value={demod.volumeDb}
          onChange={(e) => onChange({ volumeDb: parseFloat(e.target.value) })}
          className="range range-xs range-primary w-full"
        />
      </label>
      <div
        className="input input-bordered input-sm flex items-center justify-between font-mono text-[10px]"
        style={{ color: statusPill.color }}
      >
        <span>{statusPill.label}</span>
        {demod.enabled && status === 'streaming' && (
          <span className="opacity-70 ml-1">{queuedMs}ms</span>
        )}
      </div>
      <p className="text-[10px] opacity-50">
        Click the spectrum to retune. Audio is 48 kHz mono PCM.
      </p>
    </div>
  );
}
