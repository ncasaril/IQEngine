"""SDR capture and monitoring endpoints."""

import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .sdr_device import CaptureJob, SDRConfig, get_capture_jobs, get_device, get_device_lock, write_sigmf_recording
from .sdr_monitor import MonitorRunner, get_active_monitors

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
    segment_duration_s: float = Field(10.0, description="Duration per segment in seconds")
    max_segments: int = Field(50, description="Maximum segments to keep (oldest evicted)")
    antenna: str = Field("", description="Antenna port name")


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

    runner = MonitorRunner(
        session_id=session_id,
        config=config,
        segment_duration_s=req.segment_duration_s,
        max_segments=req.max_segments,
        output_base_dir=base_dir,
    )

    monitors[session_id] = runner
    runner.start()

    return {"session_id": session_id, "status": "running"}


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
