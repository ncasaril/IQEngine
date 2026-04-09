"""Agent REST API — structured JSON endpoints for AI agent consumption and MCP compatibility."""

import base64
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from helpers.datasource_access import check_access
from helpers.samples import get_bytes_per_iq_sample, get_samples
from helpers.spectrogram_engine import apply_colormap, compute_spectrogram_db, rgb_to_png
from helpers.urlmapping import ApiType, get_file_name

from . import datasources
from .agent_analysis import detect_signals
from .agent_models import (
    AgentCapability,
    AgentCaptureRequest,
    AgentMonitorRequest,
    AgentResponse,
    AgentTuneRequest,
    SpectrogramRequest,
)
from .azure_client import AzureBlobClient
from .database import db
from .models import DataSource

logger = logging.getLogger("api")

router = APIRouter(prefix="/api/agent", tags=["agent"])


# --- Helper to build Azure client with credentials ---

async def _get_client(datasource: DataSource) -> AzureBlobClient:
    from helpers.cipher import decrypt

    client = AzureBlobClient(account=datasource.account, container=datasource.container, awsAccessKeyId=datasource.awsAccessKeyId)
    if hasattr(datasource, "sasToken") and datasource.sasToken:
        client.set_sas_token(decrypt(datasource.sasToken.get_secret_value()))
    if hasattr(datasource, "awsSecretAccessKey") and datasource.awsSecretAccessKey:
        client.set_aws_secret_access_key(decrypt(datasource.awsSecretAccessKey.get_secret_value()))
    return client


# --- Capabilities endpoint ---


@router.get("/capabilities")
async def get_capabilities():
    """Self-describing tool list for MCP autodiscovery."""
    tools = [
        AgentCapability(
            name="list_recordings",
            description="Search and list available RF recordings with optional frequency and sample rate filters",
            method="GET",
            path="/api/agent/recordings",
            parameters=[
                {"name": "center_freq_min", "type": "float", "description": "Min center frequency Hz"},
                {"name": "center_freq_max", "type": "float", "description": "Max center frequency Hz"},
                {"name": "limit", "type": "int", "description": "Max results (default 50)"},
            ],
        ),
        AgentCapability(
            name="get_recording",
            description="Get full metadata for a specific recording",
            method="GET",
            path="/api/agent/recordings/{account}/{container}/{filepath}",
        ),
        AgentCapability(
            name="get_spectrogram",
            description="Generate a spectrogram image (base64 PNG) for a recording with configurable FFT params",
            method="GET",
            path="/api/agent/recordings/{account}/{container}/{filepath}/spectrogram",
            parameters=[
                {"name": "fft_size", "type": "int", "description": "FFT size (default 1024)"},
                {"name": "time_start_s", "type": "float", "description": "Start time in seconds"},
                {"name": "time_duration_s", "type": "float", "description": "Duration in seconds"},
                {"name": "cmap", "type": "string", "description": "Colormap name"},
            ],
        ),
        AgentCapability(
            name="analyze_recording",
            description="Detect signals in a recording: finds signals above noise floor, returns frequencies and power levels",
            method="GET",
            path="/api/agent/recordings/{account}/{container}/{filepath}/analysis",
            parameters=[
                {"name": "fft_size", "type": "int", "description": "FFT size (default 1024)"},
                {"name": "threshold_db", "type": "float", "description": "Detection threshold above noise floor (default 10)"},
            ],
        ),
        AgentCapability(
            name="get_annotations",
            description="Get SigMF annotations for a recording in structured format",
            method="GET",
            path="/api/agent/recordings/{account}/{container}/{filepath}/annotations",
        ),
        AgentCapability(
            name="capture",
            description="Trigger an SDR capture at specified frequency, returns job_id for polling",
            method="POST",
            path="/api/agent/capture",
        ),
        AgentCapability(
            name="capture_and_analyze",
            description="Capture from SDR then immediately generate spectrogram and signal analysis",
            method="POST",
            path="/api/agent/capture-and-analyze",
        ),
        AgentCapability(
            name="tune_sdr",
            description="Change SDR frequency/gain (synchronous)",
            method="POST",
            path="/api/agent/sdr/tune",
        ),
        AgentCapability(
            name="start_monitor",
            description="Start continuous SDR monitoring with rolling segment capture",
            method="POST",
            path="/api/agent/monitor",
        ),
        AgentCapability(
            name="get_job_status",
            description="Check status of an async capture or monitor job",
            method="GET",
            path="/api/agent/jobs/{id}",
        ),
    ]
    return AgentResponse(status="success", data={"tools": [t.dict() for t in tools]})


# --- Recording endpoints ---


@router.get("/recordings")
async def list_recordings(
    center_freq_min: Optional[float] = None,
    center_freq_max: Optional[float] = None,
    sample_rate_min: Optional[float] = None,
    description_contains: Optional[str] = None,
    account: Optional[str] = None,
    container: Optional[str] = None,
    limit: int = 50,
):
    """Query available recordings with optional filters."""
    metadata_collection = db().metadata
    query = {}

    if account:
        query["global.traceability:origin.account"] = account
    if container:
        query["global.traceability:origin.container"] = container
    if center_freq_min is not None or center_freq_max is not None:
        freq_filter = {}
        if center_freq_min is not None:
            freq_filter["$gte"] = center_freq_min
        if center_freq_max is not None:
            freq_filter["$lte"] = center_freq_max
        query["captures.0.core:frequency"] = freq_filter
    if sample_rate_min is not None:
        query["global.core:sample_rate"] = {"$gte": sample_rate_min}
    if description_contains:
        query["global.core:description"] = {"$regex": description_contains, "$options": "i"}

    cursor = metadata_collection.find(query, {"_id": 0}).limit(limit)
    results = await cursor.to_list(length=limit)

    recordings = []
    for meta in results:
        origin = meta.get("global", {}).get("traceability:origin", {})
        captures = meta.get("captures", [])
        recordings.append({
            "account": origin.get("account", ""),
            "container": origin.get("container", ""),
            "file_path": origin.get("file_path", ""),
            "data_type": meta.get("global", {}).get("core:datatype", ""),
            "sample_rate": meta.get("global", {}).get("core:sample_rate"),
            "center_freq": captures[0].get("core:frequency") if captures else None,
            "description": meta.get("global", {}).get("core:description", ""),
            "num_samples": meta.get("global", {}).get("traceability:sample_length"),
            "num_annotations": len(meta.get("annotations", [])),
        })

    return AgentResponse(status="success", data={"recordings": recordings, "count": len(recordings)})


@router.get("/recordings/{account}/{container}/{filepath:path}/spectrogram")
async def get_recording_spectrogram(
    filepath: str,
    fft_size: int = Query(1024, description="FFT size"),
    time_start_s: float = Query(0.0, description="Start time in seconds"),
    time_duration_s: Optional[float] = Query(None, description="Duration in seconds"),
    window: str = Query("hanning", description="Window function"),
    cmap: str = Query("viridis", description="Colormap"),
    mag_min: Optional[float] = Query(None, description="Min dB"),
    mag_max: Optional[float] = Query(None, description="Max dB"),
    datasource: DataSource = Depends(datasources.get),
    access_allowed=Depends(check_access),
):
    """Generate spectrogram as base64 PNG with axis metadata."""
    if access_allowed is None:
        raise HTTPException(status_code=403, detail="No Access")
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    client = await _get_client(datasource)
    iq_file = get_file_name(filepath, ApiType.IQDATA)
    meta_file = get_file_name(filepath, ApiType.METADATA)

    # Read metadata
    try:
        meta_bytes = await client.get_blob_content(filepath=meta_file)
        meta = json.loads(meta_bytes)
        data_type = meta["global"]["core:datatype"]
        sample_rate = meta["global"].get("core:sample_rate", 1.0)
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read metadata")

    bytes_per_sample = get_bytes_per_iq_sample(data_type)
    file_length = await client.get_file_length(iq_file)
    total_samples = file_length // bytes_per_sample

    # Calculate sample range
    sample_start = int(time_start_s * sample_rate)
    if time_duration_s is not None:
        sample_count = int(time_duration_s * sample_rate)
    else:
        sample_count = total_samples - sample_start

    # Cap to avoid massive spectrograms — limit to ~4M samples for agent use
    max_agent_samples = 4 * 1024 * 1024
    sample_count = min(sample_count, max_agent_samples, total_samples - sample_start)

    if sample_count <= 0:
        raise HTTPException(status_code=400, detail="No samples in requested range")

    # Read samples
    byte_offset = sample_start * bytes_per_sample
    byte_length = sample_count * bytes_per_sample
    content = await client.get_blob_content(filepath=iq_file, offset=byte_offset, length=byte_length)
    samples = get_samples(content, data_type)

    # Compute spectrogram
    db_array = compute_spectrogram_db(samples, fft_size, window)
    rgb = apply_colormap(db_array, cmap=cmap, mag_min=mag_min, mag_max=mag_max)
    png_bytes = rgb_to_png(rgb)

    image_b64 = "data:image/png;base64," + base64.b64encode(png_bytes).decode()

    captures = meta.get("captures", [])
    center_freq = captures[0].get("core:frequency", 0) if captures else 0

    axes = {
        "x_label": "Frequency (Hz)",
        "x_min_hz": center_freq - sample_rate / 2,
        "x_max_hz": center_freq + sample_rate / 2,
        "y_label": "Time (s)",
        "y_min_s": time_start_s,
        "y_max_s": time_start_s + len(samples) / sample_rate,
        "cbar_label": "Power (dB)",
        "cbar_min_db": float(mag_min) if mag_min else float(db_array.min()) if db_array.size > 0 else 0,
        "cbar_max_db": float(mag_max) if mag_max else float(db_array.max()) if db_array.size > 0 else 0,
    }

    context = {
        "center_freq_hz": center_freq,
        "sample_rate_hz": sample_rate,
        "data_type": data_type,
        "fft_size": fft_size,
        "num_ffts": db_array.shape[0] if db_array.size > 0 else 0,
    }

    return AgentResponse(status="success", data={"image_base64": image_b64, "axes": axes}, context=context)


@router.get("/recordings/{account}/{container}/{filepath:path}/analysis")
async def analyze_recording(
    filepath: str,
    fft_size: int = Query(1024, description="FFT size"),
    threshold_db: float = Query(10.0, description="Detection threshold above noise floor in dB"),
    time_start_s: float = Query(0.0, description="Start time in seconds"),
    time_duration_s: Optional[float] = Query(None, description="Duration in seconds"),
    datasource: DataSource = Depends(datasources.get),
    access_allowed=Depends(check_access),
):
    """Detect signals in a recording."""
    if access_allowed is None:
        raise HTTPException(status_code=403, detail="No Access")
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    client = await _get_client(datasource)
    iq_file = get_file_name(filepath, ApiType.IQDATA)
    meta_file = get_file_name(filepath, ApiType.METADATA)

    try:
        meta_bytes = await client.get_blob_content(filepath=meta_file)
        meta = json.loads(meta_bytes)
        data_type = meta["global"]["core:datatype"]
        sample_rate = meta["global"].get("core:sample_rate", 1.0)
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read metadata")

    captures = meta.get("captures", [])
    center_freq = captures[0].get("core:frequency", 0) if captures else 0

    bytes_per_sample = get_bytes_per_iq_sample(data_type)
    file_length = await client.get_file_length(iq_file)
    total_samples = file_length // bytes_per_sample

    sample_start = int(time_start_s * sample_rate)
    if time_duration_s is not None:
        sample_count = int(time_duration_s * sample_rate)
    else:
        sample_count = total_samples - sample_start

    # Limit for analysis
    max_samples = 4 * 1024 * 1024
    sample_count = min(sample_count, max_samples, total_samples - sample_start)

    byte_offset = sample_start * bytes_per_sample
    byte_length = sample_count * bytes_per_sample
    content = await client.get_blob_content(filepath=iq_file, offset=byte_offset, length=byte_length)
    samples = get_samples(content, data_type)

    signals, summary = detect_signals(samples, fft_size, sample_rate, center_freq, threshold_db)

    context = {"center_freq_hz": center_freq, "sample_rate_hz": sample_rate, "time_start_s": time_start_s, "time_duration_s": len(samples) / sample_rate}

    return AgentResponse(status="success", data={"signals": signals, "summary": summary}, context=context)


@router.get("/recordings/{account}/{container}/{filepath:path}/annotations")
async def get_annotations(
    filepath: str,
    datasource: DataSource = Depends(datasources.get),
    access_allowed=Depends(check_access),
):
    """Get SigMF annotations in agent-friendly format."""
    if access_allowed is None:
        raise HTTPException(status_code=403, detail="No Access")
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    client = await _get_client(datasource)
    from helpers.urlmapping import ApiType, get_file_name

    meta_file = get_file_name(filepath, ApiType.METADATA)
    try:
        meta_bytes = await client.get_blob_content(filepath=meta_file)
        meta = json.loads(meta_bytes)
    except Exception:
        raise HTTPException(status_code=404, detail="Recording not found")

    sample_rate = meta.get("global", {}).get("core:sample_rate", 1.0)
    captures = meta.get("captures", [])
    center_freq = captures[0].get("core:frequency", 0) if captures else 0
    annotations = meta.get("annotations", [])

    formatted = []
    for ann in annotations:
        sample_start = ann.get("core:sample_start", 0)
        sample_count = ann.get("core:sample_count", 0)
        freq_lower = ann.get("core:freq_lower_edge")
        freq_upper = ann.get("core:freq_upper_edge")
        formatted.append({
            "label": ann.get("core:label", ""),
            "description": ann.get("core:description", ""),
            "sample_start": sample_start,
            "sample_count": sample_count,
            "time_start_s": sample_start / sample_rate if sample_rate else 0,
            "duration_s": sample_count / sample_rate if sample_rate else 0,
            "freq_lower_hz": freq_lower,
            "freq_upper_hz": freq_upper,
            "generator": ann.get("core:generator", ""),
            "extra": {k: v for k, v in ann.items() if not k.startswith("core:")},
        })

    context = {"center_freq_hz": center_freq, "sample_rate_hz": sample_rate, "num_annotations": len(formatted)}

    return AgentResponse(status="success", data={"annotations": formatted}, context=context)


# NOTE: this route must be defined AFTER the /spectrogram, /analysis, /annotations
# sub-routes because filepath:path greedily matches slashes and would otherwise
# swallow the sub-path suffix.
@router.get("/recordings/{account}/{container}/{filepath:path}")
async def get_recording(
    filepath: str,
    datasource: DataSource = Depends(datasources.get),
    access_allowed=Depends(check_access),
):
    """Get full metadata for a specific recording."""
    if access_allowed is None:
        raise HTTPException(status_code=403, detail="No Access")
    if not datasource:
        raise HTTPException(status_code=404, detail="Datasource not found")

    client = await _get_client(datasource)
    from helpers.urlmapping import ApiType, get_file_name

    meta_file = get_file_name(filepath, ApiType.METADATA)
    try:
        meta_bytes = await client.get_blob_content(filepath=meta_file)
        meta = json.loads(meta_bytes)
    except Exception:
        raise HTTPException(status_code=404, detail="Recording not found")

    captures = meta.get("captures", [])
    context = {}
    if captures:
        context["center_freq_hz"] = captures[0].get("core:frequency")
    context["sample_rate_hz"] = meta.get("global", {}).get("core:sample_rate")
    context["data_type"] = meta.get("global", {}).get("core:datatype")

    # Calculate total samples from file size
    try:
        iq_file = get_file_name(filepath, ApiType.IQDATA)
        file_length = await client.get_file_length(iq_file)
        bytes_per_sample = get_bytes_per_iq_sample(meta["global"]["core:datatype"])
        context["num_samples"] = file_length // bytes_per_sample
    except Exception:
        context["num_samples"] = meta.get("global", {}).get("traceability:sample_length")

    return AgentResponse(status="success", data=meta, context=context)


# --- SDR capture endpoints for agents ---


@router.post("/capture", status_code=202)
async def agent_capture(req: AgentCaptureRequest):
    """Trigger an SDR capture, returns job_id for polling."""
    from .sdr_device import CaptureJob, SDRConfig, get_capture_jobs, get_device, get_device_lock, write_sigmf_recording
    from .sdr_router import _run_capture
    import asyncio
    import uuid
    from datetime import datetime, timezone

    device = get_device()
    device_lock = get_device_lock()

    if not device_lock.acquire(blocking=False):
        return AgentResponse(status="error", error="SDR device is busy")

    job_id = str(uuid.uuid4())[:8]
    config = SDRConfig(center_freq=req.center_freq, sample_rate=req.sample_rate, gain=req.gain)
    job = CaptureJob(
        job_id=job_id,
        status="pending",
        config=config,
        duration_s=req.duration_s,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    get_capture_jobs()[job_id] = job
    device_lock.release()

    asyncio.get_event_loop().run_in_executor(None, _run_capture, job)

    return AgentResponse(status="pending", job_id=job_id, data={"message": f"Capture started, poll /api/agent/jobs/{job_id}"})


@router.post("/capture-and-analyze", status_code=202)
async def agent_capture_and_analyze(req: AgentCaptureRequest):
    """Capture + spectrogram + analysis in one call. Returns job_id."""
    # Reuse the capture endpoint, the caller polls for results and then calls spectrogram/analysis
    from .sdr_device import CaptureJob, SDRConfig, get_capture_jobs, get_device, get_device_lock, write_sigmf_recording
    from .sdr_router import _run_capture
    import asyncio
    import uuid
    from datetime import datetime, timezone

    device = get_device()
    device_lock = get_device_lock()

    if not device_lock.acquire(blocking=False):
        return AgentResponse(status="error", error="SDR device is busy")

    job_id = str(uuid.uuid4())[:8]
    config = SDRConfig(center_freq=req.center_freq, sample_rate=req.sample_rate, gain=req.gain)
    job = CaptureJob(
        job_id=job_id,
        status="pending",
        config=config,
        duration_s=req.duration_s,
        created_at=datetime.now(timezone.utc).isoformat(),
    )
    get_capture_jobs()[job_id] = job
    device_lock.release()

    asyncio.get_event_loop().run_in_executor(None, _run_capture, job)

    return AgentResponse(
        status="pending",
        job_id=job_id,
        data={
            "message": "Capture started. Once complete, use the filepath to call /spectrogram and /analysis",
            "next_steps": [
                f"GET /api/agent/jobs/{job_id} — poll until status=complete",
                "GET /api/agent/recordings/{{account}}/{{container}}/{{filepath}}/spectrogram — view result",
                "GET /api/agent/recordings/{{account}}/{{container}}/{{filepath}}/analysis — detect signals",
            ],
        },
    )


@router.post("/sdr/tune")
async def agent_tune_sdr(req: AgentTuneRequest):
    """Tune SDR synchronously."""
    from .sdr_device import SDRConfig, get_device, get_device_lock

    device = get_device()
    device_lock = get_device_lock()

    if not device_lock.acquire(timeout=5):
        return AgentResponse(status="error", error="SDR device is busy")

    try:
        if not device.is_open:
            device.open()
        status = device.get_status()
        config = SDRConfig(
            center_freq=req.center_freq if req.center_freq is not None else status.get("center_freq_hz", 915e6),
            sample_rate=req.sample_rate if req.sample_rate is not None else status.get("sample_rate_hz", 2e6),
            gain=req.gain if req.gain is not None else status.get("gain_db", 40.0),
        )
        device.configure(config)
        return AgentResponse(status="success", data=device.get_status())
    finally:
        device_lock.release()


@router.post("/monitor")
async def agent_start_monitor(req: AgentMonitorRequest):
    """Start continuous SDR monitoring."""
    from .sdr_device import SDRConfig
    from .sdr_monitor import MonitorRunner, get_active_monitors
    import os
    import uuid

    monitors = get_active_monitors()
    for mid, m in monitors.items():
        if m.status == "running":
            return AgentResponse(status="error", error=f"Monitor {mid} already running")

    session_id = str(uuid.uuid4())[:8]
    config = SDRConfig(center_freq=req.center_freq, sample_rate=req.sample_rate, gain=req.gain)
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

    return AgentResponse(status="pending", job_id=session_id, data={"message": "Monitor started", "session_id": session_id})


# --- Job management ---


@router.get("/jobs/{job_id}")
async def get_job_status(job_id: str):
    """Check status of a capture job or monitor session."""
    from .sdr_device import get_capture_jobs
    from .sdr_monitor import get_active_monitors

    # Check capture jobs
    jobs = get_capture_jobs()
    if job_id in jobs:
        job = jobs[job_id]
        return AgentResponse(
            status=job.status,
            job_id=job.job_id,
            data={
                "type": "capture",
                "progress": job.progress,
                "filepath": job.filepath,
                "samples_captured": job.samples_captured,
                "dropped_samples": job.dropped_samples,
                "created_at": job.created_at,
                "completed_at": job.completed_at,
            },
            error=job.error,
        )

    # Check monitor sessions
    monitors = get_active_monitors()
    if job_id in monitors:
        runner = monitors[job_id]
        segments = runner.segments
        return AgentResponse(
            status=runner.status,
            job_id=job_id,
            data={
                "type": "monitor",
                "segment_count": len(segments),
                "config": {"center_freq_hz": runner.config.center_freq, "sample_rate_hz": runner.config.sample_rate, "gain_db": runner.config.gain},
                "latest_segments": [{"filepath": s.filepath, "timestamp": s.timestamp} for s in segments[-5:]],
            },
            error=runner.error,
        )

    raise HTTPException(status_code=404, detail="Job not found")


@router.get("/jobs/{job_id}/events")
async def get_job_events(job_id: str, cursor: int = Query(0, description="Segment index to start from")):
    """Get detected events/segments from a monitor job (cursor-based pagination)."""
    from .sdr_monitor import get_active_monitors

    monitors = get_active_monitors()
    if job_id not in monitors:
        raise HTTPException(status_code=404, detail="Monitor session not found")

    runner = monitors[job_id]
    segments = runner.segments
    new_segments = [s for s in segments if s.index >= cursor]

    return AgentResponse(
        status="success",
        data={
            "events": [{"index": s.index, "filepath": s.filepath, "center_freq_hz": s.center_freq, "timestamp": s.timestamp, "num_samples": s.num_samples} for s in new_segments],
            "next_cursor": new_segments[-1].index + 1 if new_segments else cursor,
        },
    )


@router.delete("/jobs/{job_id}")
async def cancel_job(job_id: str):
    """Cancel a capture job or stop a monitor session."""
    from .sdr_device import get_capture_jobs
    from .sdr_monitor import get_active_monitors

    jobs = get_capture_jobs()
    if job_id in jobs:
        jobs[job_id].status = "cancelled"
        return AgentResponse(status="success", data={"message": "Job cancelled"})

    monitors = get_active_monitors()
    if job_id in monitors:
        monitors[job_id].stop()
        return AgentResponse(status="success", data={"message": "Monitor stopped"})

    raise HTTPException(status_code=404, detail="Job not found")


@router.post("/plugins/{plugin_name}/run")
async def run_plugin(
    plugin_name: str,
    account: str = Query(..., description="Datasource account"),
    container: str = Query(..., description="Datasource container"),
    filepath: str = Query(..., description="Recording file path"),
):
    """Execute a plugin on a recording (delegates to existing plugin system)."""
    # Find the plugin URL
    plugins_collection = db().plugins
    plugin = await plugins_collection.find_one({"name": plugin_name})
    if not plugin:
        raise HTTPException(status_code=404, detail=f"Plugin '{plugin_name}' not found")

    import httpx

    plugin_url = plugin["url"]
    try:
        async with httpx.AsyncClient(timeout=60.0) as http_client:
            resp = await http_client.post(
                f"{plugin_url}/run",
                json={"account": account, "container": container, "filepath": filepath},
            )
            resp.raise_for_status()
            result = resp.json()
    except Exception as e:
        return AgentResponse(status="error", error=f"Plugin execution failed: {e}")

    return AgentResponse(status="success", data=result)
