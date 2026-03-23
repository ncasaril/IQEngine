"""Continuous SDR monitoring with rolling segment capture."""

import logging
import os
import queue
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

import numpy as np

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
        self._websocket_subscribers: List = []

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

    def add_websocket_subscriber(self, ws):
        self._websocket_subscribers.append(ws)

    def remove_websocket_subscriber(self, ws):
        if ws in self._websocket_subscribers:
            self._websocket_subscribers.remove(ws)

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
