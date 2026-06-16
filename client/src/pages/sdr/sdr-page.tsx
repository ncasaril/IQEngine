import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LiveWaterfall } from './LiveWaterfall';

interface SDRDevice {
  index?: number;
  driver: string;
  label: string;
  serial: string;
  hardware: string;
}

interface CaptureForm {
  center_freq: number;
  sample_rate: number;
  gain: number;
  duration_s: number;
}

interface MonitorForm {
  center_freq: number;
  sample_rate: number;
  gain: number;
  segment_duration_s: number;
  max_segments: number;
}

interface MonitorStatus {
  session_id: string | null;
  status: string;
  config?: { center_freq_hz: number; sample_rate_hz: number; gain_db: number };
  segment_count?: number;
  segments?: { index: number; filepath: string; timestamp: string }[];
  error?: string;
}

export function SDRPage() {
  const [devices, setDevices] = useState<SDRDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<number>(0);
  const [deviceStatus, setDeviceStatus] = useState<any>(null);
  const [captureForm, setCaptureForm] = useState<CaptureForm>({
    center_freq: 915e6,
    sample_rate: 2e6,
    gain: 40,
    duration_s: 1.0,
  });
  const [monitorForm, setMonitorForm] = useState<MonitorForm>({
    center_freq: 915e6,
    sample_rate: 2e6,
    gain: 40,
    segment_duration_s: 10,
    max_segments: 50,
  });
  const [captureJobId, setCaptureJobId] = useState<string | null>(null);
  const [captureStatus, setCaptureStatus] = useState<string>('');
  const [monitorStatus, setMonitorStatus] = useState<MonitorStatus | null>(null);
  const [error, setError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');

  // Fetch devices on mount
  useEffect(() => {
    fetch('/api/sdr/devices')
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then((data) => setDevices(data.devices || []))
      .catch((e) => setError(`SDR not available: ${e}`));
  }, []);

  const refreshStatus = useCallback(() => {
    fetch('/api/sdr/status')
      .then((r) => r.json())
      .then(setDeviceStatus)
      .catch(() => {});
  }, []);

  // Pull authoritative monitor status from the server. Keeps a session object
  // only when there's a real session, so an orphaned monitor started in another
  // tab/session is detected on page load (and the Stop controls appear).
  const fetchMonitorStatus = useCallback(() => {
    return fetch('/api/sdr/monitor/status')
      .then((r) => r.json())
      .then((data) => {
        setMonitorStatus(data && data.session_id ? data : null);
        return data;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    fetchMonitorStatus();
  }, [refreshStatus, fetchMonitorStatus]);

  // Poll capture status
  useEffect(() => {
    if (!captureJobId) return;
    const interval = setInterval(() => {
      fetch(`/api/sdr/capture/${captureJobId}/status`)
        .then((r) => r.json())
        .then((data) => {
          setCaptureStatus(`${data.status} — ${data.samples_captured} samples`);
          if (data.status === 'complete' || data.status === 'error') {
            clearInterval(interval);
            if (data.filepath) {
              setCaptureStatus(`Complete: ${data.filepath}`);
            }
            if (data.error) {
              setError(data.error);
            }
            refreshStatus();
          }
        });
    }, 500);
    return () => clearInterval(interval);
  }, [captureJobId, refreshStatus]);

  // Poll monitor status
  useEffect(() => {
    if (!monitorStatus || monitorStatus.status !== 'running') return;
    const interval = setInterval(() => {
      fetch('/api/sdr/monitor/status')
        .then((r) => r.json())
        .then(setMonitorStatus);
    }, 2000);
    return () => clearInterval(interval);
  }, [monitorStatus?.status]);

  const startCapture = async () => {
    setError('');
    setCaptureStatus('Starting...');
    try {
      const resp = await fetch('/api/sdr/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...captureForm, device_index: selectedDevice }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        throw new Error(data.detail || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setCaptureJobId(data.job_id);
    } catch (e: any) {
      setError(e.message);
      setCaptureStatus('');
    }
  };

  const startMonitor = async () => {
    setError('');
    try {
      const resp = await fetch('/api/sdr/monitor/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...monitorForm, device_index: selectedDevice }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        // 409 = a monitor is already running (possibly orphaned from another
        // tab). Surface it so the Stop controls appear.
        if (resp.status === 409) {
          await fetchMonitorStatus();
        }
        throw new Error(data.detail || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setMonitorStatus({ session_id: data.session_id, status: 'running' });
    } catch (e: any) {
      setError(e.message);
    }
  };

  const stopMonitor = async () => {
    try {
      await fetch('/api/sdr/monitor/stop', { method: 'POST' });
      await fetchMonitorStatus();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const stopAllMonitors = async () => {
    setError('');
    try {
      const resp = await fetch('/api/sdr/monitor/stop-all', { method: 'POST' });
      const data = await resp.json();
      await fetchMonitorStatus();
      refreshStatus();
      setNotice(data.count > 0 ? `Stopped ${data.count} monitor session(s).` : 'No monitors were running.');
    } catch (e: any) {
      setError(e.message);
    }
  };

  const retune = async () => {
    try {
      await fetch('/api/sdr/monitor/retune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          center_freq: monitorForm.center_freq,
          gain: monitorForm.gain,
        }),
      });
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="p-4 max-w-4xl mx-auto">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-2xl font-bold">SDR Control</h1>
        <a href="/sdr/live" className="btn btn-sm btn-primary">
          Open Live View →
        </a>
      </div>

      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setError('')}>
            x
          </button>
        </div>
      )}

      {notice && (
        <div className="alert alert-info mb-4">
          <span>{notice}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setNotice('')}>
            x
          </button>
        </div>
      )}

      {/* Device Info */}
      <div className="card bg-base-200 p-4 mb-4">
        <h2 className="text-lg font-bold mb-2">Devices</h2>
        {devices.length === 0 ? (
          <p className="text-sm opacity-70">No SDR devices detected (SDR feature may be disabled)</p>
        ) : (
          <>
            <ul className="text-sm">
              {devices.map((d, i) => (
                <li key={i}>
                  <strong>{d.label}</strong> — {d.driver} (serial: {d.serial || 'N/A'})
                </li>
              ))}
            </ul>
            <label className="text-sm mt-2 flex items-center gap-2">
              <span className="opacity-70">Active device</span>
              <select
                className="select select-bordered select-sm"
                value={selectedDevice}
                onChange={(e) => setSelectedDevice(parseInt(e.target.value))}
              >
                {devices.map((d, i) => (
                  <option key={i} value={d.index ?? i}>
                    [{d.index ?? i}] {d.label} ({d.driver})
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs opacity-60 mt-1">Used for the next capture or monitor start.</p>
          </>
        )}
        {deviceStatus && (
          <div className="mt-2 text-sm">
            Status: {deviceStatus.is_open ? 'Open' : 'Closed'} | {(deviceStatus.center_freq_hz / 1e6).toFixed(1)} MHz |{' '}
            {(deviceStatus.sample_rate_hz / 1e6).toFixed(1)} Msps | {deviceStatus.gain_db} dB
          </div>
        )}
      </div>

      {/* On-Demand Capture */}
      <div className="card bg-base-200 p-4 mb-4">
        <h2 className="text-lg font-bold mb-2">On-Demand Capture</h2>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <label className="text-sm">
            Center Freq (MHz)
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={captureForm.center_freq / 1e6}
              onChange={(e) => setCaptureForm({ ...captureForm, center_freq: parseFloat(e.target.value) * 1e6 })}
            />
          </label>
          <label className="text-sm">
            Sample Rate (Msps)
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={captureForm.sample_rate / 1e6}
              onChange={(e) => setCaptureForm({ ...captureForm, sample_rate: parseFloat(e.target.value) * 1e6 })}
            />
          </label>
          <label className="text-sm">
            Gain (dB)
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={captureForm.gain}
              onChange={(e) => setCaptureForm({ ...captureForm, gain: parseFloat(e.target.value) })}
            />
          </label>
          <label className="text-sm">
            Duration (s)
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={captureForm.duration_s}
              onChange={(e) => setCaptureForm({ ...captureForm, duration_s: parseFloat(e.target.value) })}
            />
          </label>
        </div>
        <button className="btn btn-primary btn-sm" onClick={startCapture} disabled={!!captureJobId && !captureStatus.startsWith('Complete')}>
          Capture
        </button>
        {captureStatus && <div className="mt-2 text-sm">{captureStatus}</div>}
      </div>

      {/* Continuous Monitoring */}
      <div className="card bg-base-200 p-4 mb-4">
        <h2 className="text-lg font-bold mb-2">Continuous Monitoring</h2>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <label className="text-sm">
            Center Freq (MHz)
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={monitorForm.center_freq / 1e6}
              onChange={(e) => setMonitorForm({ ...monitorForm, center_freq: parseFloat(e.target.value) * 1e6 })}
            />
          </label>
          <label className="text-sm">
            Sample Rate (Msps)
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={monitorForm.sample_rate / 1e6}
              onChange={(e) => setMonitorForm({ ...monitorForm, sample_rate: parseFloat(e.target.value) * 1e6 })}
            />
          </label>
          <label className="text-sm">
            Gain (dB)
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={monitorForm.gain}
              onChange={(e) => setMonitorForm({ ...monitorForm, gain: parseFloat(e.target.value) })}
            />
          </label>
          <label className="text-sm">
            Segment Duration (s)
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={monitorForm.segment_duration_s}
              onChange={(e) => setMonitorForm({ ...monitorForm, segment_duration_s: parseFloat(e.target.value) })}
            />
          </label>
          <label className="text-sm">
            Max Segments
            <input
              type="number"
              className="input input-bordered input-sm w-full"
              value={monitorForm.max_segments}
              onChange={(e) => setMonitorForm({ ...monitorForm, max_segments: parseInt(e.target.value) })}
            />
          </label>
        </div>
        <div className="flex gap-2 items-center">
          {monitorStatus?.status !== 'running' ? (
            <button className="btn btn-primary btn-sm" onClick={startMonitor}>
              Start Monitor
            </button>
          ) : (
            <>
              <button className="btn btn-error btn-sm" onClick={stopMonitor}>
                Stop
              </button>
              <button className="btn btn-warning btn-sm" onClick={retune}>
                Retune
              </button>
            </>
          )}
          <button
            className="btn btn-outline btn-error btn-sm ml-auto"
            onClick={stopAllMonitors}
            title="Force-stop any monitor running on the server, including sessions started in another tab or browser that are still capturing."
          >
            Stop All Monitors
          </button>
        </div>
        {monitorStatus && (
          <div className="mt-2 text-sm">
            <div>
              Session: {monitorStatus.session_id} | Status: {monitorStatus.status} | Segments: {monitorStatus.segment_count ?? 0}
            </div>
            {monitorStatus.error && <div className="text-error">Error: {monitorStatus.error}</div>}
            {monitorStatus.segments && monitorStatus.segments.length > 0 && (
              <div className="mt-1">
                <div className="text-xs opacity-70">Recent segments:</div>
                {monitorStatus.segments.slice(-5).map((s) => (
                  <div key={s.index} className="text-xs">
                    #{s.index} — {s.filepath} ({s.timestamp})
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Live Waterfall */}
      {monitorStatus?.status === 'running' && (
        <div className="card bg-base-200 p-4">
          <h2 className="text-lg font-bold mb-2">Live Waterfall</h2>
          <LiveWaterfall
            active={monitorStatus?.status === 'running'}
            fftSize={1024}
            cmap="viridis"
            maxRows={128}
            height={800}
          />
        </div>
      )}
    </div>
  );
}
