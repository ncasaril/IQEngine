"""SDR capture and monitoring endpoints."""

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from .sdr_audio import AUDIO_RATE, DemodConfig, SUPPORTED_MODES, MODE_NFM
from .sdr_device import CaptureJob, SDRConfig, get_capture_jobs, get_device, get_device_lock, write_sigmf_recording
from .sdr_monitor import AudioSubscriber, MonitorRunner, SpectrumSubscriber, WaterfallSubscriber, get_active_monitors

logger = logging.getLogger("api")

router = APIRouter(prefix="/api/sdr", tags=["sdr"])


# --- Request/Response models ---


class CaptureRequest(BaseModel):
    center_freq: float = Field(..., description="Center frequency in Hz")
    sample_rate: float = Field(2e6, description="Sample rate in Hz")
    gain: float = Field(40.0, description="Gain in dB")
    duration_s: float = Field(1.0, description="Capture duration in seconds")
    antenna: str = Field("", description="Antenna port name")
    bandwidth: float = Field(0.0, description="Bandwidth in Hz (0=auto)")


class MonitorStartRequest(BaseModel):
    center_freq: float = Field(..., description="Center frequency in Hz")
    sample_rate: float = Field(2e6, description="Sample rate in Hz")
    gain: float = Field(40.0, description="Gain in dB")
    segment_duration_s: float = Field(10.0, description="Duration per segment in seconds (0 disables disk segment writes)")
    max_segments: int = Field(50, description="Maximum segments to keep (0 disables disk segment writes)")
    antenna: str = Field("", description="Antenna port name")
    rolling_window_s: float = Field(30.0, description="Rolling IQ buffer length in seconds (capped to ~512 MB)")


class RetuneRequest(BaseModel):
    center_freq: Optional[float] = Field(None, description="New center frequency in Hz")
    gain: Optional[float] = Field(None, description="New gain in dB")
    sample_rate: Optional[float] = Field(None, description="New sample rate in Hz")


# --- Endpoints ---


@router.get("/devices")
async def list_devices():
    """Enumerate connected SDR hardware."""
    device = get_device()
    devices = device.enumerate()
    return {"devices": [{"driver": d.driver, "label": d.label, "serial": d.serial, "hardware": d.hardware, "extra": d.extra} for d in devices]}


@router.get("/status")
async def get_status():
    """Current SDR device state."""
    device = get_device()
    return device.get_status()


@router.post("/capture", status_code=202)
async def start_capture(req: CaptureRequest):
    """Start an on-demand SDR capture. Returns 202 with job_id."""
    device = get_device()
    device_lock = get_device_lock()

    if not device_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail="SDR device is busy")

    job_id = str(uuid.uuid4())[:8]
    config = SDRConfig(
        center_freq=req.center_freq,
        sample_rate=req.sample_rate,
        gain=req.gain,
        antenna=req.antenna,
        bandwidth=req.bandwidth,
    )

    job = CaptureJob(
        job_id=job_id,
        status="pending",
        config=config,
        duration_s=req.duration_s,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    get_capture_jobs()[job_id] = job

    # Release lock — the background task will re-acquire it
    device_lock.release()

    # Run capture in background thread (blocking SoapySDR calls)
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run_capture, job, loop)

    return {"job_id": job_id, "status": "pending"}


def _run_capture(job: CaptureJob, loop=None):
    """Execute capture in a background thread."""
    device = get_device()
    device_lock = get_device_lock()

    if not device_lock.acquire(timeout=30):
        job.status = "error"
        job.error = "Timeout acquiring device lock"
        return

    try:
        job.status = "running"
        if not device.is_open:
            device.open()
        device.configure(job.config)

        num_samples = int(job.config.sample_rate * job.duration_s)
        samples = device.read_samples(num_samples)
        job.samples_captured = len(samples)
        job.progress = 1.0

        # Write SigMF recording
        base_dir = os.getenv("IQENGINE_BACKEND_LOCAL_FILEPATH", os.path.join(os.getcwd(), "iqengine"))
        output_dir = os.path.join(base_dir, "sdr_captures")
        basename = write_sigmf_recording(samples, job.config, output_dir, "ondemand")
        job.filepath = os.path.join("sdr_captures", basename)

        device.close()
        job.status = "complete"
        job.completed_at = datetime.now(timezone.utc).isoformat()
        logger.info(f"Capture {job.job_id} complete: {job.filepath}")

        # Auto-register in metadata DB so the recording is immediately browsable
        if loop is not None:
            try:
                asyncio.run_coroutine_threadsafe(_register_capture_metadata(job.filepath, job.config), loop)
            except Exception as e:
                logger.warning(f"Failed to auto-register capture: {e}")

    except Exception as e:
        logger.error(f"Capture {job.job_id} failed: {e}")
        job.status = "error"
        job.error = str(e)
        try:
            device.close()
        except Exception:
            pass
    finally:
        device_lock.release()


async def _register_capture_metadata(filepath: str, config):
    """Register a captured SigMF recording in the metadata DB so it appears in the browser."""
    from .metadata import create

    meta = {
        "global": {
            "core:datatype": "cf32_le",
            "core:sample_rate": config.sample_rate,
            "core:version": "1.0.0",
            "core:description": f"SDR capture at {config.center_freq/1e6:.1f} MHz",
            "traceability:origin": {
                "type": "api",
                "account": "local",
                "container": "local",
                "file_path": filepath,
            },
            "traceability:revision": 0,
        },
        "captures": [{"core:sample_start": 0, "core:frequency": config.center_freq, "core:datetime": datetime.now(timezone.utc).isoformat()}],
        "annotations": [],
    }

    # Compute sample length from the file we just wrote
    base_dir = os.getenv("IQENGINE_BACKEND_LOCAL_FILEPATH", "")
    data_path = os.path.join(base_dir, filepath + ".sigmf-data")
    if os.path.exists(data_path):
        meta["global"]["traceability:sample_length"] = os.path.getsize(data_path) // 8  # cf32 = 8 bytes/sample

    await create(meta, user=None)
    logger.info(f"Registered capture in metadata DB: {filepath}")


@router.get("/capture/{job_id}/status")
async def get_capture_status(job_id: str):
    """Poll capture job status."""
    jobs = get_capture_jobs()
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    job = jobs[job_id]
    return {
        "job_id": job.job_id,
        "status": job.status,
        "progress": job.progress,
        "filepath": job.filepath,
        "samples_captured": job.samples_captured,
        "dropped_samples": job.dropped_samples,
        "error": job.error,
        "created_at": job.created_at,
        "completed_at": job.completed_at,
    }


@router.post("/monitor/start", status_code=202)
async def start_monitor(req: MonitorStartRequest):
    """Start continuous rolling SDR capture."""
    monitors = get_active_monitors()

    # Only one monitor at a time
    for mid, m in monitors.items():
        if m.status == "running":
            raise HTTPException(status_code=409, detail=f"Monitor {mid} already running. Stop it first.")

    session_id = str(uuid.uuid4())[:8]
    config = SDRConfig(
        center_freq=req.center_freq,
        sample_rate=req.sample_rate,
        gain=req.gain,
        antenna=req.antenna,
    )

    base_dir = os.getenv("IQENGINE_BACKEND_LOCAL_FILEPATH", os.path.join(os.getcwd(), "iqengine"))

    # Wire up metadata registration so each segment is browsable immediately
    loop = asyncio.get_event_loop()

    def _register_segment_callback(filepath, cfg):
        asyncio.run_coroutine_threadsafe(_register_capture_metadata(filepath, cfg), loop)

    runner = MonitorRunner(
        session_id=session_id,
        config=config,
        segment_duration_s=req.segment_duration_s,
        max_segments=req.max_segments,
        output_base_dir=base_dir,
        register_metadata_callback=_register_segment_callback,
        rolling_window_s=req.rolling_window_s,
    )

    monitors[session_id] = runner
    runner.start()

    return {
        "session_id": session_id,
        "status": "running",
        "rolling_window_s": runner.rolling_window_s,
        "segments_enabled": req.segment_duration_s > 0 and req.max_segments > 0,
    }


@router.post("/monitor/stop")
async def stop_monitor():
    """Stop the running monitor session."""
    monitors = get_active_monitors()
    running = [(mid, m) for mid, m in monitors.items() if m.status == "running"]
    if not running:
        raise HTTPException(status_code=404, detail="No active monitor session")

    session_id, runner = running[0]
    runner.stop()
    return {"session_id": session_id, "status": "stopped"}


@router.post("/monitor/retune")
async def retune_monitor(req: RetuneRequest):
    """Change frequency/gain mid-capture (applied at next segment boundary)."""
    monitors = get_active_monitors()
    running = [(mid, m) for mid, m in monitors.items() if m.status == "running"]
    if not running:
        raise HTTPException(status_code=404, detail="No active monitor session")

    _, runner = running[0]
    runner.retune(center_freq=req.center_freq, gain=req.gain, sample_rate=req.sample_rate)
    return {"status": "retune_queued"}


@router.get("/monitor/status")
async def get_monitor_status():
    """Get status of the current monitor session."""
    monitors = get_active_monitors()
    running = [(mid, m) for mid, m in monitors.items() if m.status == "running"]
    if not running:
        # Return most recent if any
        if monitors:
            session_id = list(monitors.keys())[-1]
            runner = monitors[session_id]
        else:
            return {"session_id": None, "status": "no_session"}
    else:
        session_id, runner = running[0]

    segments = runner.segments
    return {
        "session_id": session_id,
        "status": runner.status,
        "config": {
            "center_freq_hz": runner.config.center_freq,
            "sample_rate_hz": runner.config.sample_rate,
            "gain_db": runner.config.gain,
        },
        "segment_count": len(segments),
        "segments": [{"index": s.index, "filepath": s.filepath, "center_freq": s.center_freq, "timestamp": s.timestamp, "num_samples": s.num_samples} for s in segments[-10:]],  # last 10
        "error": runner.error,
    }


class SnapshotRequest(BaseModel):
    duration_s: float = Field(10.0, description="Window length in seconds (taken from the rolling buffer)")
    offset_s: float = Field(0.0, description="How many seconds ago the window ends (0 = up to 'now')")


@router.post("/monitor/snapshot", status_code=201)
async def snapshot_monitor(req: SnapshotRequest):
    """Slice the rolling IQ buffer of the running monitor and write it out as a full SigMF recording.

    Auto-registers the recording in the metadata DB so it immediately appears in the browser
    and via /api/agent/recordings.
    """
    monitors = get_active_monitors()
    running = [(mid, m) for mid, m in monitors.items() if m.status == "running"]
    if not running:
        raise HTTPException(status_code=404, detail="No active monitor session")

    _, runner = running[0]
    samples, cfg_snap = runner.snapshot(req.duration_s, req.offset_s)
    if samples.size == 0:
        raise HTTPException(status_code=400, detail="No samples available in the requested window")

    base_dir = os.getenv("IQENGINE_BACKEND_LOCAL_FILEPATH", os.path.join(os.getcwd(), "iqengine"))
    output_dir = os.path.join(base_dir, "sdr_captures")
    basename = write_sigmf_recording(samples, cfg_snap, output_dir, "snapshot")
    filepath = os.path.join("sdr_captures", basename)

    try:
        await _register_capture_metadata(filepath, cfg_snap)
    except Exception as e:
        logger.warning(f"Failed to register snapshot metadata: {e}")

    return {
        "filepath": filepath,
        "account": "local",
        "container": "local",
        "num_samples": int(samples.size),
        "duration_s": float(samples.size / cfg_snap.sample_rate),
        "center_freq_hz": cfg_snap.center_freq,
        "sample_rate_hz": cfg_snap.sample_rate,
    }


@router.websocket("/monitor/spectrum")
async def live_spectrum(
    ws: WebSocket,
    fft_size: int = 4096,
    frame_rate: float = 10.0,
    window: str = "hanning",
    dc_remove: bool = False,
    dc_notch_bins: int = 2,
):
    """Stream live FFT frames as binary float32 dB arrays from the rolling buffer.

    Query params:
      fft_size:  FFT length per frame (128-32768, default 4096). One FFT = fft_size samples.
      frame_rate: Frames per second (1-30, default 10). Bandwidth ~= frame_rate * fft_size * 4 bytes.
      window: Window function (hanning, hamming, blackman, rectangle).

    Protocol:
      On connect: JSON header {type: "config", fft_size, frame_rate, center_freq_hz, sample_rate_hz, bin_hz}
      Per frame:  JSON metadata {type: "frame", timestamp, center_freq_hz, sample_rate_hz, ...}
                  then binary float32[fft_size] in dB (fft-shifted so bin 0 = lowest frequency).
    """
    await ws.accept()

    # Clamp params — protects server and matches gqrx-ish sane ranges
    frame_rate = max(1.0, min(float(frame_rate), 30.0))
    fft_size = max(128, min(int(fft_size), 32768))

    monitors = get_active_monitors()
    running = [(mid, m) for mid, m in monitors.items() if m.status == "running"]
    if not running:
        await ws.send_json({"type": "error", "error": "No active monitor session"})
        await ws.close()
        return

    session_id, runner = running[0]
    loop = asyncio.get_event_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=64)
    subscriber = SpectrumSubscriber(
        queue=q,
        loop=loop,
        fft_size=fft_size,
        frame_rate=frame_rate,
        window=window,
        dc_remove=bool(dc_remove),
        dc_notch_bins=max(0, min(int(dc_notch_bins), 16)),
    )
    runner.add_spectrum_subscriber(subscriber)

    try:
        await ws.send_json({
            "type": "config",
            "session_id": session_id,
            "fft_size": fft_size,
            "frame_rate": frame_rate,
            "window": window,
            "center_freq_hz": runner.config.center_freq,
            "sample_rate_hz": runner.config.sample_rate,
            "bin_hz": runner.config.sample_rate / fft_size,
            "dtype": "float32",
            "fft_shifted": True,
            "rolling_window_s": runner.rolling_window_s,
            "dc_remove": subscriber.dc_remove,
            "dc_notch_bins": subscriber.dc_notch_bins,
        })

        while True:
            data = await q.get()
            if data is None:
                await ws.send_json({"type": "stopped"})
                break
            binary = data.pop("_binary")
            await ws.send_json(data)
            await ws.send_bytes(binary)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"Live spectrum WS error: {e}")
    finally:
        runner.remove_spectrum_subscriber(subscriber)


@router.websocket("/monitor/audio")
async def live_audio(
    ws: WebSocket,
    mode: str = "nfm",
    center_hz: float = 0.0,
    bandwidth_hz: float = 15_000.0,
    volume_db: float = 0.0,
    squelch_db: float = -120.0,
):
    """Stream demodulated audio (48 kHz mono int16 PCM) from the running monitor.

    Connect with the initial demod config as query params, then send JSON text
    frames `{ "type": "set", ...fields }` to retune / change bandwidth / volume
    without reconnecting. Supported modes: nfm, wfm, am, usb, lsb.
    """
    await ws.accept()

    mode = mode.lower()
    if mode not in SUPPORTED_MODES:
        await ws.send_json({"type": "error", "error": f"unsupported mode: {mode}"})
        await ws.close()
        return

    monitors = get_active_monitors()
    running = [(mid, m) for mid, m in monitors.items() if m.status == "running"]
    if not running:
        await ws.send_json({"type": "error", "error": "No active monitor session"})
        await ws.close()
        return

    session_id, runner = running[0]
    loop = asyncio.get_event_loop()
    q: asyncio.Queue = asyncio.Queue(maxsize=128)

    cfg = DemodConfig(
        mode=mode,
        center_hz=float(center_hz) if center_hz > 0 else float(runner.config.center_freq),
        bandwidth_hz=max(100.0, float(bandwidth_hz)),
        volume_db=float(volume_db),
        squelch_db=float(squelch_db),
    )
    subscriber = AudioSubscriber(queue=q, loop=loop, config=cfg)
    runner.add_audio_subscriber(subscriber)

    # Background task that drains inbound control messages from the client
    async def receive_loop():
        try:
            while True:
                msg = await ws.receive_json()
                if not isinstance(msg, dict):
                    continue
                t = msg.get("type")
                if t == "set":
                    new_cfg = DemodConfig(
                        mode=str(msg.get("mode", subscriber.config.mode)).lower(),
                        center_hz=float(msg.get("center_hz", subscriber.config.center_hz)),
                        bandwidth_hz=max(100.0, float(msg.get("bandwidth_hz", subscriber.config.bandwidth_hz))),
                        volume_db=float(msg.get("volume_db", subscriber.config.volume_db)),
                        squelch_db=float(msg.get("squelch_db", subscriber.config.squelch_db)),
                        muted=bool(msg.get("muted", subscriber.config.muted)),
                    )
                    if new_cfg.mode not in SUPPORTED_MODES:
                        await ws.send_json({"type": "error", "error": f"unsupported mode: {new_cfg.mode}"})
                        continue
                    runner.update_audio_config(subscriber, new_cfg)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.warning(f"Audio WS receive loop error: {e}")

    recv_task = asyncio.create_task(receive_loop())

    try:
        await ws.send_json({
            "type": "config",
            "session_id": session_id,
            "sample_rate": AUDIO_RATE,
            "format": "pcm_s16le",
            "channels": 1,
            "mode": cfg.mode,
            "center_hz": cfg.center_hz,
            "bandwidth_hz": cfg.bandwidth_hz,
            "monitor_center_hz": runner.config.center_freq,
            "monitor_sample_rate_hz": runner.config.sample_rate,
        })

        while True:
            data = await q.get()
            if data is None:
                await ws.send_json({"type": "stopped"})
                break
            binary = data.pop("_binary")
            await ws.send_json(data)
            await ws.send_bytes(binary)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"Live audio WS error: {e}")
    finally:
        recv_task.cancel()
        runner.remove_audio_subscriber(subscriber)


@router.websocket("/monitor/live")
async def live_waterfall(
    ws: WebSocket,
    fft_size: int = 1024,
    cmap: str = "viridis",
    max_rows: int = 64,
):
    """Stream live spectrogram strips from the active monitor session.

    Query params: fft_size, cmap, max_rows (max rows per strip).
    Sends: text frame (JSON config), then alternating text (metadata) + binary (PNG) per segment.
    """
    await ws.accept()

    monitors = get_active_monitors()
    running = [(mid, m) for mid, m in monitors.items() if m.status == "running"]
    if not running:
        await ws.send_json({"type": "error", "error": "No active monitor session"})
        await ws.close()
        return

    session_id, runner = running[0]
    loop = asyncio.get_event_loop()
    q: asyncio.Queue = asyncio.Queue()
    subscriber = WaterfallSubscriber(
        queue=q,
        loop=loop,
        fft_size=fft_size,
        cmap=cmap,
        max_rows=max_rows,
    )
    runner.add_waterfall_subscriber(subscriber)

    try:
        # Send initial config
        await ws.send_json({
            "type": "config",
            "session_id": session_id,
            "fft_size": fft_size,
            "cmap": cmap,
            "max_rows": max_rows,
            "center_freq_hz": runner.config.center_freq,
            "sample_rate_hz": runner.config.sample_rate,
        })

        while True:
            data = await q.get()
            if data is None:
                # Monitor stopped
                await ws.send_json({"type": "stopped"})
                break

            # data is a dict with "type", "rows", "cols", "png", etc.
            png_bytes = data.pop("png")
            await ws.send_json(data)  # metadata text frame
            await ws.send_bytes(png_bytes)  # PNG binary frame

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"Live waterfall WS error: {e}")
    finally:
        runner.remove_waterfall_subscriber(subscriber)
