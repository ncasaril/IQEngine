import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SpectrumPlot, SpectrumConfig } from './SpectrumPlot';
import { SpectrumWaterfall } from './SpectrumWaterfall';
import { DemodPlayer, DemodState } from './DemodPlayer';
import { TopTabs } from '@/pages/shared/top-tabs';

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

const FORM_STORAGE_KEY = 'iqengine:sdrLiveForm';

function loadForm(): MonitorForm {
  try {
    const raw = window.localStorage.getItem(FORM_STORAGE_KEY);
    if (!raw) return DEFAULT_FORM;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_FORM, ...parsed };
  } catch {
    return DEFAULT_FORM;
  }
}

export function SDRLivePage() {
  const [form, setForm] = useState<MonitorForm>(() => loadForm());

  // Persist form changes so freq/sample-rate/gain/buffer stick across reloads
  useEffect(() => {
    try {
      window.localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(form));
    } catch {}
  }, [form]);

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
  const [dcRemove, setDcRemove] = useState(true);
  const [spectrumHeight, setSpectrumHeight] = useState(420);
  // Waterfall fills the remaining viewport by default. The user can override with the
  // slider; once overridden (waterfallManual=true) we stop auto-sizing.
  const [waterfallHeight, setWaterfallHeight] = useState(() =>
    Math.max(240, (typeof window !== 'undefined' ? window.innerHeight : 900) - 420 - 220)
  );
  const [waterfallManual, setWaterfallManual] = useState(false);

  // Auto-size waterfall to fill the remaining viewport on mount and window resize,
  // unless the user has taken manual control via the slider.
  useEffect(() => {
    if (waterfallManual) return;
    const recompute = () => {
      const h = Math.max(240, window.innerHeight - spectrumHeight - 220);
      setWaterfallHeight(h);
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [spectrumHeight, waterfallManual]);

  // Demodulation state — tuned independently from the monitor center frequency
  const [demod, setDemod] = useState<DemodState>({
    mode: 'nfm',
    centerHz: form.center_freq_mhz * 1e6,
    bandwidthHz: 15_000,
    volumeDb: 0,
    muted: false,
    enabled: false,
  });
  const updateDemod = useCallback((patch: Partial<DemodState>) => {
    setDemod((prev) => ({ ...prev, ...patch }));
  }, []);

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
    const newCenter = form.center_freq_mhz * 1e6;
    const newSr = form.sample_rate_msps * 1e6;
    // Preserve the demod's offset from the monitor center if it still fits in the new
    // passband; otherwise snap it to the new center so the demod doesn't aim at a
    // frequency outside the captured spectrum (which produces silence).
    const oldCenter = config?.center_freq_hz ?? newCenter;
    const offset = demod.centerHz - oldCenter;
    const halfSpan = newSr / 2;
    const retunedDemod = Math.abs(offset) <= halfSpan * 0.95 ? newCenter + offset : newCenter;
    updateDemod({ centerHz: retunedDemod });
    try {
      await fetch('/api/sdr/monitor/retune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          center_freq: newCenter,
          sample_rate: newSr,
          gain: form.gain_db,
        }),
      });
    } catch (e: any) {
      setError(e.message);
    }
  }, [form, running, config, demod.centerHz, updateDemod]);

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

  const summaryClass =
    'pl-2 mt-2 bg-primary outline outline-1 outline-primary text-lg text-base-100 hover:bg-green-800 cursor-pointer';
  const summaryFirstClass =
    'pl-2 bg-primary outline outline-1 outline-primary text-lg text-base-100 hover:bg-green-800 cursor-pointer';
  const bodyClass = 'outline outline-1 outline-primary p-2';
  const labelSmall = 'flex flex-col text-xs mb-2';

  return (
    <div className="mb-0 ml-0 mr-0 p-0 pt-3">
      <div className="flex flex-row w-full">
        {/* Left sidebar — matches recording-view */}
        <div className="flex flex-col w-64 ml-3 shrink-0">
          <details open>
            <summary className={summaryFirstClass}>Live Config</summary>
            <div className={bodyClass}>
              <label className={labelSmall}>
                <span className="opacity-70">Center (MHz)</span>
                <input
                  type="number"
                  step="0.001"
                  className="input input-bordered input-sm w-full"
                  value={form.center_freq_mhz}
                  onChange={(e) => setForm({ ...form, center_freq_mhz: parseFloat(e.target.value) })}
                />
              </label>
              <label className={labelSmall}>
                <span className="opacity-70">Sample rate (Msps)</span>
                <input
                  type="number"
                  step="0.5"
                  className="input input-bordered input-sm w-full"
                  value={form.sample_rate_msps}
                  onChange={(e) => setForm({ ...form, sample_rate_msps: parseFloat(e.target.value) })}
                />
              </label>
              <label className={labelSmall}>
                <span className="opacity-70">Gain (dB)</span>
                <input
                  type="number"
                  step="1"
                  className="input input-bordered input-sm w-full"
                  value={form.gain_db}
                  onChange={(e) => setForm({ ...form, gain_db: parseFloat(e.target.value) })}
                />
              </label>
              <label className={labelSmall}>
                <span className="opacity-70">Buffer (s)</span>
                <input
                  type="number"
                  step="1"
                  className="input input-bordered input-sm w-full"
                  value={form.rolling_window_s}
                  onChange={(e) => setForm({ ...form, rolling_window_s: parseFloat(e.target.value) })}
                />
              </label>
              <div className="flex gap-1 mt-1">
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
          </details>

          <details open>
            <summary className={summaryClass}>Display</summary>
            <div className={bodyClass}>
              <label className={labelSmall}>
                <span className="opacity-70">FFT size</span>
                <select
                  className="select select-bordered select-sm w-full"
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
              <label className={labelSmall}>
                <span className="opacity-70">Frame rate</span>
                <select
                  className="select select-bordered select-sm w-full"
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
              <label className={labelSmall}>
                <span className="opacity-70">Ref offset (dB)</span>
                <input
                  type="number"
                  step="1"
                  className="input input-bordered input-sm w-full"
                  value={refOffsetDb}
                  onChange={(e) => setRefOffsetDb(parseFloat(e.target.value))}
                />
              </label>
              <label className={labelSmall}>
                <span className="opacity-70">dB min: {minDb}</span>
                <input
                  type="range"
                  min={-140}
                  max={0}
                  step={1}
                  className="range range-xs range-primary w-full"
                  value={minDb}
                  onChange={(e) => setMinDb(parseFloat(e.target.value))}
                />
              </label>
              <label className={labelSmall}>
                <span className="opacity-70">dB max: {maxDb}</span>
                <input
                  type="range"
                  min={-100}
                  max={40}
                  step={1}
                  className="range range-xs range-primary w-full"
                  value={maxDb}
                  onChange={(e) => setMaxDb(parseFloat(e.target.value))}
                />
              </label>
              <label className={labelSmall}>
                <span className="opacity-70">Spectrum height: {spectrumHeight}px</span>
                <input
                  type="range"
                  min={200}
                  max={900}
                  step={20}
                  className="range range-xs w-full"
                  value={spectrumHeight}
                  onChange={(e) => setSpectrumHeight(parseInt(e.target.value))}
                />
              </label>
              <label className={labelSmall}>
                <span className="opacity-70">
                  Waterfall: {waterfallHeight}px (~{(waterfallHeight / frameRate).toFixed(0)}s)
                  {!waterfallManual && <span className="opacity-50"> · auto</span>}
                </span>
                <input
                  type="range"
                  min={160}
                  max={1800}
                  step={20}
                  className="range range-xs w-full"
                  value={waterfallHeight}
                  onChange={(e) => {
                    setWaterfallManual(true);
                    setWaterfallHeight(parseInt(e.target.value));
                  }}
                />
              </label>
              <div className="flex gap-1 mb-1">
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
              <div className="flex gap-1 mb-1">
                <button
                  className={`btn btn-xs flex-1 ${dcRemove ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setDcRemove((v) => !v)}
                  title="Notch the DC bins to hide the LO leakage spike"
                >
                  DC remove
                </button>
                <button
                  className={`btn btn-xs flex-1 ${paused ? 'btn-warning' : 'btn-ghost'}`}
                  onClick={() => setPaused((v) => !v)}
                  disabled={!running}
                >
                  {paused ? 'Resume' : 'Pause'}
                </button>
              </div>
            </div>
          </details>

          <details open>
            <summary className={summaryClass}>Demod</summary>
            <div className={bodyClass}>
              <DemodPlayer
                active={running}
                demod={demod}
                onChange={updateDemod}
                monitorCenterHz={config?.center_freq_hz}
                monitorSampleRateHz={config?.sample_rate_hz}
              />
            </div>
          </details>

          <details>
            <summary className={summaryClass}>Snapshot</summary>
            <div className={bodyClass + ' flex flex-col gap-2 text-xs'}>
              <label className="flex flex-col">
                <span className="opacity-70">Length (s)</span>
                <input
                  type="number"
                  step="1"
                  min="0.1"
                  className="input input-bordered input-sm w-full"
                  value={snapshotDuration}
                  onChange={(e) => setSnapshotDuration(parseFloat(e.target.value))}
                />
              </label>
              <label className="flex flex-col">
                <span className="opacity-70">Ends (s ago)</span>
                <input
                  type="number"
                  step="1"
                  min="0"
                  className="input input-bordered input-sm w-full"
                  value={snapshotOffset}
                  onChange={(e) => setSnapshotOffset(parseFloat(e.target.value))}
                />
              </label>
              <button className="btn btn-primary btn-sm" onClick={takeSnapshot} disabled={!running}>
                Snapshot to SigMF
              </button>
              {lastSnapshot && (
                <a
                  className="link text-xs break-all"
                  href={`/view/api/${lastSnapshot.account}/${lastSnapshot.container}/${encodeURIComponent(
                    lastSnapshot.filepath
                  )}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open {lastSnapshot.filepath.split('/').pop()} ({lastSnapshot.duration_s.toFixed(1)}s) →
                </a>
              )}
              {config && (
                <p className="text-[10px] opacity-50">
                  Buffer: {config.rolling_window_s.toFixed(0)}s · bin {config.bin_hz.toFixed(2)} Hz
                </p>
              )}
            </div>
          </details>
        </div>

        {/* Right main column */}
        <div className="flex flex-col pl-3 flex-1 min-w-0 pr-3">
          <TopTabs activeTab="Live" />

          <div className="flex items-center justify-between mt-2 mb-2 text-xs">
            <div className="font-mono text-[11px] px-2 py-1 bg-base-300 rounded">
              {cursor ? `${(cursor.hz / 1e6).toFixed(4)} MHz   ${cursor.db.toFixed(1)} dB` : 'cursor —'}
            </div>
            <div className="opacity-70">
              {sessionId ? `Session ${sessionId}` : ''} · {status}
            </div>
          </div>

          {error && (
            <div className="alert alert-error mb-2 py-2 text-xs">
              <span>{error}</span>
              <button className="btn btn-xs btn-ghost" onClick={dismissError}>
                x
              </button>
            </div>
          )}

          <div className="outline outline-1 outline-primary p-1 mb-2">
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
              height={spectrumHeight}
              onConfig={setConfig}
              onStatus={setStatus}
              onCursorReadout={setCursor}
              onClickFrequency={(hz) => updateDemod({ centerHz: hz })}
              channelCenterHz={demod.enabled ? demod.centerHz : null}
              channelBandwidthHz={demod.bandwidthHz}
            />
          </div>

          <div className="outline outline-1 outline-primary p-1 mb-2">
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
        </div>
      </div>

    </div>
  );
}
