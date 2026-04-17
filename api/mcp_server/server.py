"""IQEngine MCP server — exposes /api/agent/* endpoints as MCP tools."""

from __future__ import annotations

import os
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

IQENGINE_API_URL = os.getenv("IQENGINE_API_URL", "http://localhost:5000").rstrip("/")
HTTP_TIMEOUT = float(os.getenv("IQENGINE_MCP_TIMEOUT", "120"))

mcp = FastMCP("iqengine")

_client: httpx.AsyncClient | None = None


async def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=IQENGINE_API_URL, timeout=HTTP_TIMEOUT)
    return _client


async def _get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    client = await _http()
    r = await client.get(path, params={k: v for k, v in (params or {}).items() if v is not None})
    r.raise_for_status()
    return r.json()


async def _post(path: str, json: dict[str, Any] | None = None, params: dict[str, Any] | None = None) -> dict[str, Any]:
    client = await _http()
    r = await client.post(path, json=json, params={k: v for k, v in (params or {}).items() if v is not None})
    r.raise_for_status()
    return r.json()


async def _delete(path: str) -> dict[str, Any]:
    client = await _http()
    r = await client.delete(path)
    r.raise_for_status()
    return r.json()


@mcp.tool()
async def list_recordings(
    center_freq_min: float | None = None,
    center_freq_max: float | None = None,
    sample_rate_min: float | None = None,
    description_contains: str | None = None,
    account: str | None = None,
    container: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    """Search and list available RF recordings with optional frequency, sample rate, and text filters."""
    return await _get(
        "/api/agent/recordings",
        {
            "center_freq_min": center_freq_min,
            "center_freq_max": center_freq_max,
            "sample_rate_min": sample_rate_min,
            "description_contains": description_contains,
            "account": account,
            "container": container,
            "limit": limit,
        },
    )


@mcp.tool()
async def get_recording(account: str, container: str, filepath: str) -> dict[str, Any]:
    """Get full SigMF metadata for a specific recording (datatype, sample rate, captures, annotations)."""
    return await _get(f"/api/agent/recordings/{account}/{container}/{filepath}")


@mcp.tool()
async def get_spectrogram(
    account: str,
    container: str,
    filepath: str,
    fft_size: int = 1024,
    time_start_s: float = 0.0,
    time_duration_s: float | None = None,
    window: str = "hanning",
    cmap: str = "viridis",
    mag_min: float | None = None,
    mag_max: float | None = None,
) -> dict[str, Any]:
    """Generate a spectrogram PNG (base64 data URL) for a recording with configurable FFT and colormap.

    Returns image_base64 plus axes (Hz/s ranges) and context (center_freq, sample_rate, num_ffts).
    """
    return await _get(
        f"/api/agent/recordings/{account}/{container}/{filepath}/spectrogram",
        {
            "fft_size": fft_size,
            "time_start_s": time_start_s,
            "time_duration_s": time_duration_s,
            "window": window,
            "cmap": cmap,
            "mag_min": mag_min,
            "mag_max": mag_max,
        },
    )


@mcp.tool()
async def analyze_recording(
    account: str,
    container: str,
    filepath: str,
    fft_size: int = 1024,
    threshold_db: float = 10.0,
    time_start_s: float = 0.0,
    time_duration_s: float | None = None,
) -> dict[str, Any]:
    """Detect signals in a recording. Returns signals (freq range, peak power, bandwidth) plus noise floor summary."""
    return await _get(
        f"/api/agent/recordings/{account}/{container}/{filepath}/analysis",
        {
            "fft_size": fft_size,
            "threshold_db": threshold_db,
            "time_start_s": time_start_s,
            "time_duration_s": time_duration_s,
        },
    )


@mcp.tool()
async def get_annotations(account: str, container: str, filepath: str) -> dict[str, Any]:
    """Get SigMF annotations for a recording in agent-friendly format (time/freq ranges, labels)."""
    return await _get(f"/api/agent/recordings/{account}/{container}/{filepath}/annotations")


@mcp.tool()
async def capture(
    center_freq: float,
    sample_rate: float = 2_000_000.0,
    gain: float = 40.0,
    duration_s: float = 1.0,
) -> dict[str, Any]:
    """Trigger a one-shot SDR capture (HackRF/RTL-SDR/PlutoSDR). Returns job_id — poll get_job_status."""
    return await _post(
        "/api/agent/capture",
        {"center_freq": center_freq, "sample_rate": sample_rate, "gain": gain, "duration_s": duration_s},
    )


@mcp.tool()
async def capture_and_analyze(
    center_freq: float,
    sample_rate: float = 2_000_000.0,
    gain: float = 40.0,
    duration_s: float = 1.0,
) -> dict[str, Any]:
    """Capture from SDR then (after polling) call spectrogram/analysis on the resulting recording."""
    return await _post(
        "/api/agent/capture-and-analyze",
        {"center_freq": center_freq, "sample_rate": sample_rate, "gain": gain, "duration_s": duration_s},
    )


@mcp.tool()
async def tune_sdr(
    center_freq: float | None = None,
    sample_rate: float | None = None,
    gain: float | None = None,
) -> dict[str, Any]:
    """Change SDR frequency / sample rate / gain synchronously. Returns current device status."""
    return await _post(
        "/api/agent/sdr/tune",
        {"center_freq": center_freq, "sample_rate": sample_rate, "gain": gain},
    )


@mcp.tool()
async def start_monitor(
    center_freq: float,
    sample_rate: float = 2_000_000.0,
    gain: float = 40.0,
    segment_duration_s: float = 10.0,
    max_segments: int = 50,
) -> dict[str, Any]:
    """Start continuous SDR monitoring with rolling segment capture. Returns session_id."""
    return await _post(
        "/api/agent/monitor",
        {
            "center_freq": center_freq,
            "sample_rate": sample_rate,
            "gain": gain,
            "segment_duration_s": segment_duration_s,
            "max_segments": max_segments,
        },
    )


@mcp.tool()
async def get_job_status(job_id: str) -> dict[str, Any]:
    """Check status of a capture job or monitor session by id."""
    return await _get(f"/api/agent/jobs/{job_id}")


@mcp.tool()
async def get_job_events(job_id: str, cursor: int = 0) -> dict[str, Any]:
    """Get newly-captured segments from a monitor session since a cursor index."""
    return await _get(f"/api/agent/jobs/{job_id}/events", {"cursor": cursor})


@mcp.tool()
async def cancel_job(job_id: str) -> dict[str, Any]:
    """Cancel a capture job or stop a running monitor session."""
    return await _delete(f"/api/agent/jobs/{job_id}")


@mcp.tool()
async def run_plugin(plugin_name: str, account: str, container: str, filepath: str) -> dict[str, Any]:
    """Execute a named IQEngine plugin on a recording. Returns the plugin's output JSON."""
    return await _post(
        f"/api/agent/plugins/{plugin_name}/run",
        params={"account": account, "container": container, "filepath": filepath},
    )


@mcp.tool()
async def list_capabilities() -> dict[str, Any]:
    """List all agent capabilities the backend advertises (live self-describing tool list)."""
    return await _get("/api/agent/capabilities")


@mcp.tool()
async def list_sdr_devices() -> dict[str, Any]:
    """List SDR devices currently attached (HackRF / RTL-SDR / Pluto via SoapySDR)."""
    return await _get("/api/sdr/devices")


if __name__ == "__main__":
    mcp.run()
