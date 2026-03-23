"""Pydantic models for the Agent REST API with rich descriptions for MCP autodiscovery."""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class AgentResponse(BaseModel):
    """Standard response envelope for all agent endpoints."""

    status: str = Field(..., description="Response status: success, error, or pending")
    data: Optional[Any] = Field(None, description="Response payload")
    context: Optional[Dict[str, Any]] = Field(None, description="RF context: center_freq, sample_rate, time_range")
    job_id: Optional[str] = Field(None, description="Job ID for async operations")
    error: Optional[str] = Field(None, description="Error message if status is error")


class AgentCapability(BaseModel):
    """Description of a single agent capability/tool."""

    name: str = Field(..., description="Tool name for MCP invocation")
    description: str = Field(..., description="What this tool does")
    method: str = Field(..., description="HTTP method")
    path: str = Field(..., description="API endpoint path")
    parameters: Optional[List[Dict[str, str]]] = Field(None, description="List of parameter descriptions")


class RecordingQuery(BaseModel):
    """Query parameters for searching recordings."""

    center_freq_min: Optional[float] = Field(None, description="Minimum center frequency in Hz")
    center_freq_max: Optional[float] = Field(None, description="Maximum center frequency in Hz")
    sample_rate_min: Optional[float] = Field(None, description="Minimum sample rate in Hz")
    description_contains: Optional[str] = Field(None, description="Text search in description")
    account: Optional[str] = Field(None, description="Filter by datasource account")
    container: Optional[str] = Field(None, description="Filter by datasource container")
    limit: int = Field(50, description="Maximum number of results")


class SpectrogramRequest(BaseModel):
    """Parameters for spectrogram generation."""

    fft_size: int = Field(1024, description="FFT size (power of 2)")
    time_start_s: float = Field(0.0, description="Start time in seconds")
    time_duration_s: Optional[float] = Field(None, description="Duration in seconds (None = entire recording)")
    window: str = Field("hanning", description="Window function: hanning, hamming, blackman, rectangle")
    cmap: str = Field("viridis", description="Colormap: viridis, plasma, inferno, magma")
    mag_min: Optional[float] = Field(None, description="Minimum dB for colormap scaling")
    mag_max: Optional[float] = Field(None, description="Maximum dB for colormap scaling")


class DetectedSignal(BaseModel):
    """A detected signal in the spectrum."""

    freq_lower_hz: float = Field(..., description="Lower frequency bound in Hz")
    freq_upper_hz: float = Field(..., description="Upper frequency bound in Hz")
    peak_power_db: float = Field(..., description="Peak power in dB")
    bandwidth_hz: float = Field(..., description="Signal bandwidth in Hz")
    center_freq_hz: float = Field(..., description="Signal center frequency in Hz")
    time_start_s: Optional[float] = Field(None, description="Start time in seconds")
    time_stop_s: Optional[float] = Field(None, description="Stop time in seconds")


class AnalysisSummary(BaseModel):
    """Summary of signal analysis results."""

    noise_floor_db: float = Field(..., description="Estimated noise floor in dB")
    num_signals_detected: int = Field(..., description="Number of signals detected above threshold")
    occupied_bandwidth_hz: float = Field(..., description="Total occupied bandwidth in Hz")


class AnalysisResult(BaseModel):
    """Full signal analysis result."""

    signals: List[DetectedSignal] = Field(default_factory=list, description="Detected signals")
    summary: AnalysisSummary = Field(..., description="Analysis summary statistics")


class AgentCaptureRequest(BaseModel):
    """Request to capture from SDR via agent API."""

    center_freq: float = Field(..., description="Center frequency in Hz")
    sample_rate: float = Field(2e6, description="Sample rate in Hz")
    gain: float = Field(40.0, description="Gain in dB")
    duration_s: float = Field(1.0, description="Capture duration in seconds")


class AgentMonitorRequest(BaseModel):
    """Request to start SDR monitoring via agent API."""

    center_freq: float = Field(..., description="Center frequency in Hz")
    sample_rate: float = Field(2e6, description="Sample rate in Hz")
    gain: float = Field(40.0, description="Gain in dB")
    segment_duration_s: float = Field(10.0, description="Segment duration in seconds")
    max_segments: int = Field(50, description="Maximum segments to retain")


class AgentTuneRequest(BaseModel):
    """Request to tune SDR."""

    center_freq: Optional[float] = Field(None, description="New center frequency in Hz")
    gain: Optional[float] = Field(None, description="New gain in dB")
    sample_rate: Optional[float] = Field(None, description="New sample rate in Hz")
