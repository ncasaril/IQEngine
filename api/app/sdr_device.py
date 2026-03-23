"""SDR hardware abstraction layer with mock and SoapySDR implementations."""

import abc
import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

import numpy as np

logger = logging.getLogger("api")


@dataclass
class SDRDeviceInfo:
    driver: str
    label: str
    serial: str
    hardware: str
    extra: Dict[str, str] = field(default_factory=dict)


@dataclass
class SDRConfig:
    center_freq: float  # Hz
    sample_rate: float  # Hz
    gain: float = 40.0  # dB
    antenna: str = ""
    bandwidth: float = 0.0  # Hz, 0 = auto


@dataclass
class CaptureJob:
    job_id: str
    status: str  # pending, running, complete, error
    config: SDRConfig
    duration_s: float
    filepath: Optional[str] = None
    error: Optional[str] = None
    progress: float = 0.0
    samples_captured: int = 0
    dropped_samples: int = 0
    created_at: str = ""
    completed_at: Optional[str] = None


class SDRDeviceBase(abc.ABC):
    """Abstract base class for SDR devices."""

    @abc.abstractmethod
    def enumerate(self) -> List[SDRDeviceInfo]:
        """List available SDR devices."""

    @abc.abstractmethod
    def open(self, device_index: int = 0) -> None:
        """Open a specific device."""

    @abc.abstractmethod
    def close(self) -> None:
        """Close the device."""

    @abc.abstractmethod
    def configure(self, config: SDRConfig) -> None:
        """Configure frequency, sample rate, gain."""

    @abc.abstractmethod
    def read_samples(self, num_samples: int) -> np.ndarray:
        """Read complex float32 samples (blocking)."""

    @abc.abstractmethod
    def get_status(self) -> dict:
        """Return current device state."""

    @property
    @abc.abstractmethod
    def is_open(self) -> bool:
        """Whether the device is currently open."""


class MockSDRDevice(SDRDeviceBase):
    """Mock SDR device that generates synthetic signals for testing."""

    def __init__(self):
        self._open = False
        self._config = SDRConfig(center_freq=915e6, sample_rate=2e6, gain=40.0)
        self._lock = threading.Lock()

    def enumerate(self) -> List[SDRDeviceInfo]:
        return [
            SDRDeviceInfo(driver="mock", label="Mock SDR Device", serial="MOCK0001", hardware="MockHW v1.0", extra={"type": "synthetic"}),
        ]

    def open(self, device_index: int = 0) -> None:
        with self._lock:
            if self._open:
                raise RuntimeError("Device already open")
            self._open = True
            logger.info("Mock SDR device opened")

    def close(self) -> None:
        with self._lock:
            self._open = False
            logger.info("Mock SDR device closed")

    def configure(self, config: SDRConfig) -> None:
        with self._lock:
            if not self._open:
                raise RuntimeError("Device not open")
            self._config = config
            logger.info(f"Mock SDR configured: freq={config.center_freq/1e6:.1f}MHz, rate={config.sample_rate/1e6:.1f}Msps, gain={config.gain}dB")

    def read_samples(self, num_samples: int) -> np.ndarray:
        """Generate synthetic signal: tone + chirp + noise."""
        if not self._open:
            raise RuntimeError("Device not open")

        rate = self._config.sample_rate
        t = np.arange(num_samples, dtype=np.float32) / rate

        # Tone at +100kHz offset
        tone_freq = 100e3
        tone = 0.3 * np.exp(1j * 2 * np.pi * tone_freq * t).astype(np.complex64)

        # Chirp from -200kHz to +200kHz
        chirp_rate = 400e3 / (num_samples / rate)  # Hz/s
        chirp_phase = 2 * np.pi * (-200e3 * t + 0.5 * chirp_rate * t ** 2)
        chirp = 0.2 * np.exp(1j * chirp_phase).astype(np.complex64)

        # Gaussian noise
        noise_power = 0.01
        noise = np.sqrt(noise_power / 2) * (np.random.randn(num_samples).astype(np.float32) + 1j * np.random.randn(num_samples).astype(np.float32))

        # Simulate capture delay proportional to sample count
        delay = num_samples / rate
        if delay > 0.001:
            time.sleep(min(delay * 0.1, 0.5))  # simulate 10% of real time, cap at 500ms

        return (tone + chirp + noise).astype(np.complex64)

    def get_status(self) -> dict:
        return {
            "is_open": self._open,
            "driver": "mock",
            "center_freq_hz": self._config.center_freq,
            "sample_rate_hz": self._config.sample_rate,
            "gain_db": self._config.gain,
        }

    @property
    def is_open(self) -> bool:
        return self._open


class SoapySDRDevice(SDRDeviceBase):
    """Real SDR device using SoapySDR bindings."""

    def __init__(self):
        self._device = None
        self._stream = None
        self._config = SDRConfig(center_freq=915e6, sample_rate=2e6, gain=40.0)
        self._lock = threading.Lock()

    def enumerate(self) -> List[SDRDeviceInfo]:
        try:
            import SoapySDR

            results = SoapySDR.Device.enumerate()
            devices = []
            for r in results:
                devices.append(
                    SDRDeviceInfo(
                        driver=r.get("driver", "unknown"),
                        label=r.get("label", r.get("driver", "unknown")),
                        serial=r.get("serial", ""),
                        hardware=r.get("hardware", ""),
                        extra=dict(r),
                    )
                )
            return devices
        except Exception as e:
            logger.error(f"SoapySDR enumerate failed: {e}")
            return []

    def open(self, device_index: int = 0) -> None:
        import SoapySDR

        with self._lock:
            if self._device is not None:
                raise RuntimeError("Device already open")
            results = SoapySDR.Device.enumerate()
            if device_index >= len(results):
                raise RuntimeError(f"Device index {device_index} out of range (found {len(results)} devices)")
            self._device = SoapySDR.Device(results[device_index])
            logger.info(f"SoapySDR device opened: {results[device_index]}")

    def close(self) -> None:
        with self._lock:
            if self._stream is not None:
                self._device.deactivateStream(self._stream)
                self._device.closeStream(self._stream)
                self._stream = None
            if self._device is not None:
                self._device = None
            logger.info("SoapySDR device closed")

    def configure(self, config: SDRConfig) -> None:
        import SoapySDR

        with self._lock:
            if self._device is None:
                raise RuntimeError("Device not open")
            self._device.setSampleRate(SoapySDR.SOAPY_SDR_RX, 0, config.sample_rate)
            self._device.setFrequency(SoapySDR.SOAPY_SDR_RX, 0, config.center_freq)
            self._device.setGain(SoapySDR.SOAPY_SDR_RX, 0, config.gain)
            if config.antenna:
                self._device.setAntenna(SoapySDR.SOAPY_SDR_RX, 0, config.antenna)
            if config.bandwidth > 0:
                self._device.setBandwidth(SoapySDR.SOAPY_SDR_RX, 0, config.bandwidth)
            self._config = config
            logger.info(f"SoapySDR configured: freq={config.center_freq/1e6:.1f}MHz, rate={config.sample_rate/1e6:.1f}Msps")

    def read_samples(self, num_samples: int) -> np.ndarray:
        import SoapySDR

        if self._device is None:
            raise RuntimeError("Device not open")

        if self._stream is None:
            self._stream = self._device.setupStream(SoapySDR.SOAPY_SDR_RX, SoapySDR.SOAPY_SDR_CF32)
            self._device.activateStream(self._stream)

        samples = np.zeros(num_samples, dtype=np.complex64)
        total_read = 0
        buf_size = min(num_samples, 65536)
        buf = np.zeros(buf_size, dtype=np.complex64)

        while total_read < num_samples:
            to_read = min(buf_size, num_samples - total_read)
            sr = self._device.readStream(self._stream, [buf], to_read)
            if sr.ret > 0:
                samples[total_read: total_read + sr.ret] = buf[: sr.ret]
                total_read += sr.ret
            elif sr.ret == SoapySDR.SOAPY_SDR_TIMEOUT:
                continue
            elif sr.ret < 0:
                logger.warning(f"SoapySDR read error: {sr.ret}")
                break

        return samples[:total_read]

    def get_status(self) -> dict:
        return {
            "is_open": self._device is not None,
            "driver": "soapysdr",
            "center_freq_hz": self._config.center_freq,
            "sample_rate_hz": self._config.sample_rate,
            "gain_db": self._config.gain,
        }

    @property
    def is_open(self) -> bool:
        return self._device is not None


def write_sigmf_recording(samples: np.ndarray, config: SDRConfig, output_dir: str, filename_prefix: str) -> str:
    """Write IQ samples as a SigMF recording pair (.sigmf-meta, .sigmf-data).

    Returns the base filepath (without extension) relative to output_dir's parent.
    """
    os.makedirs(output_dir, exist_ok=True)

    now = datetime.now(timezone.utc)
    ts = now.strftime("%Y%m%dT%H%M%S")
    freq_mhz = config.center_freq / 1e6
    rate_msps = config.sample_rate / 1e6
    basename = f"{filename_prefix}_{ts}_{freq_mhz:.0f}MHz_{rate_msps:.0f}Msps"

    data_path = os.path.join(output_dir, f"{basename}.sigmf-data")
    meta_path = os.path.join(output_dir, f"{basename}.sigmf-meta")

    # Write raw cf32 data
    samples.astype(np.complex64).tofile(data_path)

    # Write SigMF metadata
    meta = {
        "global": {
            "core:datatype": "cf32_le",
            "core:sample_rate": config.sample_rate,
            "core:version": "1.0.0",
            "core:description": f"SDR capture at {freq_mhz:.1f} MHz",
        },
        "captures": [
            {
                "core:sample_start": 0,
                "core:frequency": config.center_freq,
                "core:datetime": now.isoformat(),
            }
        ],
        "annotations": [],
    }

    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    logger.info(f"Wrote SigMF recording: {data_path} ({samples.nbytes} bytes)")
    return basename


# Module-level singleton device and lock
_device: Optional[SDRDeviceBase] = None
_device_lock = threading.Lock()
_capture_jobs: Dict[str, CaptureJob] = {}


def get_device() -> SDRDeviceBase:
    """Get or create the singleton SDR device."""
    global _device
    if _device is None:
        # Try SoapySDR first, fall back to mock
        try:
            import SoapySDR

            _device = SoapySDRDevice()
            logger.info("Using SoapySDR device backend")
        except ImportError:
            _device = MockSDRDevice()
            logger.info("SoapySDR not available, using mock SDR device")
    return _device


def get_device_lock() -> threading.Lock:
    return _device_lock


def get_capture_jobs() -> Dict[str, CaptureJob]:
    return _capture_jobs
