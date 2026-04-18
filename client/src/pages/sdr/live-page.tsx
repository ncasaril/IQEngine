import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SpectrumPlot, SpectrumConfig } from './SpectrumPlot';
import { SpectrumWaterfall } from './SpectrumWaterfall';

interface MonitorForm {
  center_freq_mhz: number;
  sample_rate_msps: number;
  gain_db: number;
  rolling_window_s: number;
}

interface SnapshotResult {
  filepath: string;
  account: string;
  container: string;
  duration_s: number;
}

const DEFAULT_FORM: MonitorForm = {
  center_freq_mhz: 915.0,
  sample_rate_msps: 2.0,
  gain_db: 40,
  rolling_window_s: 30,
};

export function SDRLivePage() {
  const [form, setForm] = useState<MonitorForm>(DEFAULT_FORM);
  const [running, setRunning] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('idle');
  const [config, setConfig] = useState<SpectrumConfig | null>(null);

  // Display settings
  const [fftSize, setFftSize] = useState(4096);
  const [frameRate, setFrameRate] = useState(10);
  const [refOffsetDb, setRefOffsetDb] = useState(0);
  const [minDb, setMinDb] = useState(-100);
  const [maxDb, setMaxDb] = useState(-10);
  const [maxHold, setMaxHold] = useState(false);
  const [maxHoldResetKey, setMaxHoldResetKey] = useState(0);
  const [paused, setPaused] = useState(false);
  const [dcRemove, setDcRemove] = useState(false);
  const [waterfallHeight, setWaterfallHeight] = useState(360);

  // Snapshot settings
  const [snapshotDuration, setSnapshotDuration] = useState(5);
  const [snapshotOffset, setSnapshotOffset] = useState(0);
  const [lastSnapshot, setLastSnapshot] = useState<SnapshotResult | null>(null);

  // Cursor readout
  const [cursor, setCursor] = useState<{ hz: number; db: number } | null>(null);

  // Error dismiss
  const dismissError = useCallback(() => setError(''), []);

  const start = useCallback(async () => {
    setError('');
    setStatus('starting...');
    try {
      const body = {
        center_freq: form.center_freq_mhz * 1e6,
        sample_rate: form.sample_rate_msps * 1e6,
        gain: form.gain_db,
        segment_duration_s: 0,
        max_segments: 0,
        rolling_window_s: form.rolling_window_s,
      };
      const resp = await fetch('/api/sdr/monitor/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const d = await resp.json();
        throw new Error(d.detail || `HTTP ${resp.status}`);
      }
      const d = await resp.json();
      setSessionId(d.session_id);
      setRunning(true);
      setStatus('running');
    } catch (e: any) {
      setError(e.message);
      setStatus('idle');
    }
  }, [form]);

  const stop = useCallback(async () => {
    try {
      await fetch('/api/sdr/monitor/stop', { method: 'POST' });
    } catch (e: any) {
      setError(e.message);
    }
    setRunning(false);
    setStatus('stopped');
  }, []);

  const retune = useCallback(async () => {
    if (!running) return;
    try {
      await fetch('/api/sdr/monitor/retune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          center_freq: form.center_freq_mhz * 1e6,
          sample_rate: form.sample_rate_msps * 1e6,
          gain: form.gain_db,
        }),
      });
    } catch (e: any) {
      setError(e.message);
    }
  }, [form, running]);

  const takeSnapshot = useCallback(async () => {
    setError('');
    try {
      const resp = await fetch('/api/sdr/monitor/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration_s: snapshotDuration, offset_s: snapshotOffset }),
      });
      if (!resp.ok) {
        const d = await resp.json();
        throw new Error(d.detail || `HTTP ${resp.status}`);
      }
      const d: SnapshotResult = await resp.json();
      setLastSnapshot(d);
    } catch (e: any) {
      setError(e.message);
    }
  }, [snapshotDuration, snapshotOffset]);

  const resetMaxHold = useCallback(() => setMaxHoldResetKey((k) => k + 1), []);

  // Auto-stop the monitor on unmount only (not on running state transitions).
  const runningRef = useRef(false);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    return () => {
      if (runningRef.current) {
        fetch('/api/sdr/monitor/stop', { method: 'POST', keepalive: true }).catch(() => {});
      }
    };
  }, []);

  return (
    <div className="p-4 max-w-[1400px] mx-auto text-sm">
      <div className="flex items-baseline justify-between mb-3">
        <h1 className="text-xl font-bold tracking-tight">SDR Live</h1>
        <div className="opacity-70 text-xs">
          {sessionId ? `Session ${sessionId}` : ''} · {status}
        </div>
      </div>

      {error && (
        <div className="alert alert-error mb-3 py-2 text-xs">
          <span>{error}</span>
          <button className="btn btn-xs btn-ghost" onClick={dismissError}>
            x
          </button>
        </div>
      )}

      {/* Top controls row */}
      <div className="card bg-base-200 p-3 mb-3">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
          <label className="flex flex-col text-xs">
            <span className="opacity-70">Center (MHz)</span>
            <input
              type="number"
              step="0.001"
              className="input input-bordered input-sm"
              value={form.center_freq_mhz}
              onChange={(e) => setForm({ ...form, center_freq_mhz: parseFloat(e.target.value) })}
            />
          </label>
          <label className="flex flex-col text-xs">
            <span className="opacity-70">Sample rate (Msps)</span>
            <input
              type="number"
              step="0.5"
              className="input input-bordered input-sm"
              value={form.sample_rate_msps}
              onChange={(e) => setForm({ ...form, sample_rate_msps: parseFloat(e.target.value) })}
            />
          </label>
          <label className="flex flex-col text-xs">
            <span className="opacity-70">Gain (dB)</span>
            <input
              type="number"
              step="1"
              className="input input-bordered input-sm"
              value={form.gain_db}
              onChange={(e) => setForm({ ...form, gain_db: parseFloat(e.target.value) })}
            />
          </label>
          <label className="flex flex-col text-xs">
            <span className="opacity-70">Buffer (s)</span>
            <input
              type="number"
              step="1"
              className="input input-bordered input-sm"
              value={form.rolling_window_s}
              onChange={(e) => setForm({ ...form, rolling_window_s: parseFloat(e.target.value) })}
            />
          </label>
          <div className="flex gap-1 col-span-2 md:col-span-2">
            {!running ? (
              <button className="btn btn-primary btn-sm flex-1" onClick={start}>
                Start
              </button>
            ) : (
              <>
                <button className="btn btn-error btn-sm flex-1" onClick={stop}>
                  Stop
                </button>
                <button className="btn btn-warning btn-sm flex-1" onClick={retune}>
                  Retune
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Display + analyze controls row */}
      <div className="card bg-base-200 p-3 mb-3">
        <div className="grid grid-cols-2 md:grid-cols-8 gap-2 items-end">
          <label className="flex flex-col text-xs">
            <span className="opacity-70">FFT size</span>
            <select
              className="select select-bordered select-sm"
              value={fftSize}
              onChange={(e) => setFftSize(parseInt(e.target.value))}
            >
              {[1024, 2048, 4096, 8192, 16384].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs">
            <span className="opacity-70">Frame rate</span>
            <select
              className="select select-bordered select-sm"
              value={frameRate}
              onChange={(e) => setFrameRate(parseInt(e.target.value))}
            >
              {[5, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n} Hz
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs">
            <span className="opacity-70">Ref offset (dB)</span>
            <input
              type="number"
              step="1"
              className="input input-bordered input-sm"
              value={refOffsetDb}
              onChange={(e) => setRefOffsetDb(parseFloat(e.target.value))}
            />
          </label>
          <label className="flex flex-col text-xs">
            <span className="opacity-70">dB min</span>
            <input
              type="number"
              step="5"
              className="input input-bordered input-sm"
              value={minDb}
              onChange={(e) => setMinDb(parseFloat(e.target.value))}
            />
          </label>
          <label className="flex flex-col text-xs">
            <span className="opacity-70">dB max</span>
            <input
              type="number"
              step="5"
              className="input input-bordered input-sm"
              value={maxDb}
              onChange={(e) => setMaxDb(parseFloat(e.target.value))}
            />
          </label>
          <div className="flex flex-col text-xs gap-1">
            <span className="opacity-70">Display</span>
            <div className="flex gap-1">
              <button
                className={`btn btn-xs flex-1 ${maxHold ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => setMaxHold((v) => !v)}
              >
                Max-hold
              </button>
              <button className="btn btn-xs btn-ghost" onClick={resetMaxHold} title="Reset max-hold">
                ↻
              </button>
            </div>
          </div>
          <div className="flex flex-col text-xs gap-1">
            <span className="opacity-70">Filters</span>
            <button
              className={`btn btn-xs ${dcRemove ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setDcRemove((v) => !v)}
              title="Notch the DC bins to hide the HackRF LO leakage spike (display only — IQ is untouched)"
            >
              DC remove
            </button>
          </div>
          <div className="flex flex-col text-xs gap-1">
            <span className="opacity-70">Transport</span>
            <button
              className={`btn btn-xs ${paused ? 'btn-warning' : 'btn-ghost'}`}
              onClick={() => setPaused((v) => !v)}
              disabled={!running}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
          </div>
          <div className="flex flex-col text-xs">
            <span className="opacity-70">Cursor</span>
            <div className="font-mono text-[11px] h-[30px] flex items-center px-2 bg-base-300 rounded">
              {cursor
                ? `${(cursor.hz / 1e6).toFixed(4)} MHz   ${cursor.db.toFixed(1)} dB`
                : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Spectrum */}
      <div className="card bg-base-200 p-2 mb-3">
        <SpectrumPlot
          active={running}
          fftSize={fftSize}
          frameRate={frameRate}
          refOffsetDb={refOffsetDb}
          minDb={minDb}
          maxDb={maxDb}
          maxHold={maxHold}
          paused={paused}
          dcRemove={dcRemove}
          maxHoldResetKey={maxHoldResetKey}
          height={260}
          onConfig={setConfig}
          onStatus={setStatus}
          onCursorReadout={setCursor}
        />
      </div>

      {/* Waterfall — driven by the same /spectrum WS so it scrolls at frame_rate */}
      <div className="card bg-base-200 p-2 mb-3">
        <div className="flex items-center justify-end gap-2 mb-1 text-xs">
          <span className="opacity-70">Height</span>
          <input
            type="range"
            min={160}
            max={1200}
            step={40}
            value={waterfallHeight}
            onChange={(e) => setWaterfallHeight(parseInt(e.target.value))}
            className="range range-xs w-40"
            title={`${waterfallHeight}px`}
          />
          <span className="font-mono opacity-70 w-12 text-right">{waterfallHeight}px</span>
        </div>
        <SpectrumWaterfall
          active={running}
          fftSize={fftSize}
          frameRate={frameRate}
          minDb={minDb}
          maxDb={maxDb}
          refOffsetDb={refOffsetDb}
          paused={paused}
          dcRemove={dcRemove}
          height={waterfallHeight}
        />
      </div>

      {/* Snapshot */}
      <div className="card bg-base-200 p-3 mb-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs">
            <span className="opacity-70">Snapshot length (s)</span>
            <input
              type="number"
              step="1"
              min="0.1"
              className="input input-bordered input-sm w-28"
              value={snapshotDuration}
              onChange={(e) => setSnapshotDuration(parseFloat(e.target.value))}
            />
          </label>
          <label className="flex flex-col text-xs">
            <span className="opacity-70">Ends (s ago)</span>
            <input
              type="number"
              step="1"
              min="0"
              className="input input-bordered input-sm w-28"
              value={snapshotOffset}
              onChange={(e) => setSnapshotOffset(parseFloat(e.target.value))}
            />
          </label>
          <button className="btn btn-primary btn-sm" onClick={takeSnapshot} disabled={!running}>
            Snapshot to SigMF
          </button>
          {lastSnapshot && (
            <a
              className="link text-xs"
              href={`/view/api/${lastSnapshot.account}/${lastSnapshot.container}/${encodeURIComponent(
                lastSnapshot.filepath
              )}`}
              target="_blank"
              rel="noreferrer"
            >
              Open {lastSnapshot.filepath} ({lastSnapshot.duration_s.toFixed(1)}s) →
            </a>
          )}
        </div>
        {config && (
          <p className="text-[10px] opacity-50 mt-2">
            Rolling buffer: {config.rolling_window_s.toFixed(0)} s at {(config.sample_rate_hz / 1e6).toFixed(3)} Msps
            · bin = {config.bin_hz.toFixed(2)} Hz
          </p>
        )}
      </div>
    </div>
  );
}
