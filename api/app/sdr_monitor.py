"""Continuous SDR monitoring with rolling segment capture."""

import asyncio
import logging
import math
import os
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

import numpy as np

from helpers.spectrogram_engine import apply_colormap, compute_spectrogram_db, rgb_to_png

from .sdr_device import SDRConfig, SDRDeviceBase, get_device, get_device_lock, write_sigmf_recording

logger = logging.getLogger("api")


@dataclass
class MonitorSegment:
    index: int
    filepath: str
    center_freq: float
    sample_rate: float
    timestamp: str
    num_samples: int


@dataclass
class MonitorSession:
    session_id: str
    config: SDRConfig
    segment_duration_s: float
    max_segments: int
    status: str  # running, stopped, error
    segments: List[MonitorSegment] = field(default_factory=list)
    error: Optional[str] = None
    created_at: str = ""
    stopped_at: Optional[str] = None


@dataclass
class WaterfallSubscriber:
    """A WebSocket subscriber that receives live spectrogram strips."""
    queue: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    fft_size: int = 1024
    cmap: str = "viridis"
    max_rows: int = 64
    mag_min: Optional[float] = None
    mag_max: Optional[float] = None


class MonitorRunner:
    """Runs continuous SDR capture in a dedicated thread."""

    def __init__(
        self,
        session_id: str,
        config: SDRConfig,
        segment_duration_s: float,
        max_segments: int,
        output_base_dir: str,
        register_metadata_callback=None,
    ):
        self.session_id = session_id
        self.config = config
        self.segment_duration_s = segment_duration_s
        self.max_segments = max_segments
        self.output_dir = os.path.join(output_base_dir, "sdr_captures", f"monitor_{session_id}")
        self.register_metadata_callback = register_metadata_callback

        self._stop_event = threading.Event()
        self._retune_queue: queue.Queue = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._segments: List[MonitorSegment] = []
        self._lock = threading.Lock()
        self._status = "pending"
        self._error: Optional[str] = None
        self._waterfall_subscribers: List[WaterfallSubscriber] = []
        self._waterfall_lock = threading.Lock()

    @property
    def status(self) -> str:
        return self._status

    @property
    def error(self) -> Optional[str]:
        return self._error

    @property
    def segments(self) -> List[MonitorSegment]:
        with self._lock:
            return list(self._segments)

    def start(self):
        """Start the monitor thread."""
        self._thread = threading.Thread(target=self._run, name=f"sdr-monitor-{self.session_id}", daemon=True)
        self._status = "running"
        self._thread.start()

    def stop(self):
        """Signal the monitor thread to stop."""
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)
        self._status = "stopped"

    def retune(self, center_freq: Optional[float] = None, gain: Optional[float] = None, sample_rate: Optional[float] = None):
        """Queue a retune command (applied at next segment boundary)."""
        cmd = {}
        if center_freq is not None:
            cmd["center_freq"] = center_freq
        if gain is not None:
            cmd["gain"] = gain
        if sample_rate is not None:
            cmd["sample_rate"] = sample_rate
        self._retune_queue.put(cmd)

    def add_waterfall_subscriber(self, subscriber: WaterfallSubscriber):
        with self._waterfall_lock:
            self._waterfall_subscribers.append(subscriber)

    def remove_waterfall_subscriber(self, subscriber: WaterfallSubscriber):
        with self._waterfall_lock:
            if subscriber in self._waterfall_subscribers:
                self._waterfall_subscribers.remove(subscriber)

    def _notify_waterfall_subscribers(self, samples: np.ndarray, segment_index: int):
        """Compute spectrogram strips and push to all WebSocket subscribers."""
        with self._waterfall_lock:
            subscribers = list(self._waterfall_subscribers)
        if not subscribers:
            return

        for sub in subscribers:
            try:
                db = compute_spectrogram_db(samples, sub.fft_size)
                if db.shape[0] == 0:
                    continue

                # Decimate rows if needed
                if db.shape[0] > sub.max_rows:
                    factor = math.ceil(db.shape[0] / sub.max_rows)
                    n_out = math.ceil(db.shape[0] / factor)
                    padded = n_out * factor
                    if padded > db.shape[0]:
                        pad = np.full((padded - db.shape[0], sub.fft_size), np.nan, dtype=np.float32)
                        db = np.concatenate([db, pad], axis=0)
                    db = np.nanmean(db.reshape(n_out, factor, sub.fft_size), axis=1)

                rgb = apply_colormap(db, cmap=sub.cmap, mag_min=sub.mag_min, mag_max=sub.mag_max)
                png_bytes = rgb_to_png(rgb)

                # Push to subscriber's async queue from this thread
                sub.loop.call_soon_threadsafe(sub.queue.put_nowait, {
                    "type": "strip",
                    "rows": rgb.shape[0],
                    "cols": rgb.shape[1],
                    "segment_index": segment_index,
                    "center_freq_hz": self.config.center_freq,
                    "sample_rate_hz": self.config.sample_rate,
                    "png": png_bytes,
                })
            except Exception as e:
                logger.warning(f"Failed to send waterfall strip to subscriber: {e}")

    def _run(self):
        """Main monitor loop running in dedicated thread."""
        device = get_device()
        device_lock = get_device_lock()

        if not device_lock.acquire(timeout=5):
            self._status = "error"
            self._error = "Could not acquire device lock"
            return

        try:
            if not device.is_open:
                device.open()
            device.configure(self.config)

            segment_index = 0
            while not self._stop_event.is_set():
                # Check for retune commands
                try:
                    while True:
                        cmd = self._retune_queue.get_nowait()
                        if "center_freq" in cmd:
                            self.config.center_freq = cmd["center_freq"]
                        if "gain" in cmd:
                            self.config.gain = cmd["gain"]
                        if "sample_rate" in cmd:
                            self.config.sample_rate = cmd["sample_rate"]
                        device.configure(self.config)
                except queue.Empty:
                    pass

                # Capture one segment
                num_samples = int(self.config.sample_rate * self.segment_duration_s)
                try:
                    samples = device.read_samples(num_samples)
                except Exception as e:
                    logger.error(f"Monitor read error: {e}")
                    self._status = "error"
                    self._error = str(e)
                    break

                # Write segment
                prefix = f"{segment_index:06d}"
                basename = write_sigmf_recording(samples, self.config, self.output_dir, prefix)
                filepath = os.path.join("sdr_captures", f"monitor_{self.session_id}", basename)

                segment = MonitorSegment(
                    index=segment_index,
                    filepath=filepath,
                    center_freq=self.config.center_freq,
                    sample_rate=self.config.sample_rate,
                    timestamp=datetime.now(timezone.utc).isoformat(),
                    num_samples=len(samples),
                )

                with self._lock:
                    self._segments.append(segment)
                    # Evict oldest if over limit
                    while len(self._segments) > self.max_segments:
                        old = self._segments.pop(0)
                        self._evict_segment(old)

                # Push spectrogram strip to live waterfall subscribers
                self._notify_waterfall_subscribers(samples, segment_index)

                # Register metadata in DB (if callback provided)
                if self.register_metadata_callback:
                    try:
                        self.register_metadata_callback(filepath, self.config)
                    except Exception as e:
                        logger.warning(f"Failed to register segment metadata: {e}")

                segment_index += 1

        except Exception as e:
            logger.error(f"Monitor thread error: {e}")
            self._status = "error"
            self._error = str(e)
        finally:
            try:
                device.close()
            except Exception:
                pass
            device_lock.release()
            if self._status != "error":
                self._status = "stopped"
            # Notify waterfall subscribers that monitor has stopped
            with self._waterfall_lock:
                for sub in self._waterfall_subscribers:
                    try:
                        sub.loop.call_soon_threadsafe(sub.queue.put_nowait, None)
                    except Exception:
                        pass

    def _evict_segment(self, segment: MonitorSegment):
        """Remove old segment files from disk."""
        base_dir = os.getenv("IQENGINE_BACKEND_LOCAL_FILEPATH", "")
        if not base_dir:
            return
        for ext in [".sigmf-data", ".sigmf-meta"]:
            path = os.path.join(base_dir, segment.filepath + ext)
            try:
                if os.path.exists(path):
                    os.remove(path)
                    logger.debug(f"Evicted segment: {path}")
            except Exception as e:
                logger.warning(f"Failed to evict {path}: {e}")


# Module-level active monitor sessions
_active_monitors: Dict[str, MonitorRunner] = {}


def get_active_monitors() -> Dict[str, MonitorRunner]:
    return _active_monitors
