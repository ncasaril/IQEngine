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
from typing import Dict, List, Optional, Tuple

import numpy as np

from helpers.spectrogram_engine import apply_colormap, compute_spectrogram_db, rgb_to_png

from .sdr_audio import AUDIO_RATE, DemodChain, DemodConfig
from .sdr_device import SDRConfig, SDRDeviceBase, get_device, get_device_lock, write_sigmf_recording


# Complex64 samples are 8 bytes each (float32 I + float32 Q).
_BYTES_PER_SAMPLE = 8


class RollingBuffer:
    """Thread-safe circular buffer for raw complex64 IQ samples.

    Stores the most recent `capacity` samples. Uses an absolute monotonic
    sample index (`total_written`) so subscribers / snapshots can address
    samples across wraparound.
    """

    def __init__(self, sample_rate: float, window_s: float, max_bytes: int = 512 * 1024 * 1024):
        max_samples = max_bytes // _BYTES_PER_SAMPLE
        desired = int(sample_rate * window_s)
        self.capacity = max(1, min(desired, max_samples))
        self.effective_window_s = self.capacity / sample_rate if sample_rate > 0 else 0.0
        self.sample_rate = sample_rate
        self._data = np.zeros(self.capacity, dtype=np.complex64)
        self.total_written = 0
        self._lock = threading.Lock()

    def write(self, samples: np.ndarray) -> None:
        if samples.size == 0:
            return
        with self._lock:
            n = samples.size
            if n >= self.capacity:
                self._data[:] = samples[-self.capacity:]
                self.total_written += n
                return
            head = self.total_written % self.capacity
            end = head + n
            if end <= self.capacity:
                self._data[head:end] = samples
            else:
                first = self.capacity - head
                self._data[head:] = samples[:first]
                self._data[: end - self.capacity] = samples[first:]
            self.total_written += n

    def _slice_locked(self, start_abs: int, end_abs: int) -> np.ndarray:
        oldest_valid = max(0, self.total_written - self.capacity)
        start_abs = max(start_abs, oldest_valid)
        end_abs = min(end_abs, self.total_written)
        n = end_abs - start_abs
        if n <= 0:
            return np.array([], dtype=np.complex64)
        start_idx = start_abs % self.capacity
        end_idx = end_abs % self.capacity
        if end_idx == 0 and n > 0:
            end_idx = self.capacity
        if start_idx < end_idx:
            return self._data[start_idx:end_idx].copy()
        return np.concatenate([self._data[start_idx:], self._data[:end_idx]])

    def read_latest(self, n: int) -> np.ndarray:
        with self._lock:
            if self.total_written == 0 or n <= 0:
                return np.array([], dtype=np.complex64)
            n = min(n, self.capacity)
            return self._slice_locked(self.total_written - n, self.total_written)

    def read_range(self, start_abs: int, n: int) -> np.ndarray:
        with self._lock:
            return self._slice_locked(start_abs, start_abs + n)

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


@dataclass
class AudioSubscriber:
    """A WebSocket subscriber that receives demodulated int16 PCM audio at AUDIO_RATE."""
    queue: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    config: DemodConfig
    chain: Optional[DemodChain] = None
    last_read_abs: int = 0
    stop_event: threading.Event = field(default_factory=threading.Event)
    thread: Optional[threading.Thread] = None


@dataclass
class SpectrumSubscriber:
    """A WebSocket subscriber that receives live FFT frames as binary float32 dB arrays."""
    queue: asyncio.Queue
    loop: asyncio.AbstractEventLoop
    fft_size: int = 4096
    frame_rate: float = 10.0
    window: str = "hanning"
    dc_remove: bool = False
    dc_notch_bins: int = 2  # notch ±N bins around DC (center of fft-shifted output)
    stop_event: threading.Event = field(default_factory=threading.Event)
    thread: Optional[threading.Thread] = None


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
        rolling_window_s: float = 30.0,
        chunk_duration_s: float = 0.05,
    ):
        self.session_id = session_id
        self.config = config
        self.segment_duration_s = segment_duration_s
        self.max_segments = max_segments
        self.output_dir = os.path.join(output_base_dir, "sdr_captures", f"monitor_{session_id}")
        self.register_metadata_callback = register_metadata_callback
        self.rolling_window_s = rolling_window_s
        self.chunk_duration_s = chunk_duration_s

        self._stop_event = threading.Event()
        self._retune_queue: queue.Queue = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._segments: List[MonitorSegment] = []
        self._lock = threading.Lock()
        self._status = "pending"
        self._error: Optional[str] = None
        self._waterfall_subscribers: List[WaterfallSubscriber] = []
        self._waterfall_lock = threading.Lock()
        self._spectrum_subscribers: List[SpectrumSubscriber] = []
        self._spectrum_lock = threading.Lock()
        self._audio_subscribers: List[AudioSubscriber] = []
        self._audio_lock = threading.Lock()
        self._rolling_buffer: Optional[RollingBuffer] = None

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

    def add_spectrum_subscriber(self, subscriber: SpectrumSubscriber):
        """Register a spectrum subscriber and spawn its producer thread."""
        with self._spectrum_lock:
            self._spectrum_subscribers.append(subscriber)
        subscriber.thread = threading.Thread(
            target=self._spectrum_producer,
            args=(subscriber,),
            name=f"spectrum-{id(subscriber)}",
            daemon=True,
        )
        subscriber.thread.start()

    def remove_spectrum_subscriber(self, subscriber: SpectrumSubscriber):
        subscriber.stop_event.set()
        with self._spectrum_lock:
            if subscriber in self._spectrum_subscribers:
                self._spectrum_subscribers.remove(subscriber)
        if subscriber.thread and subscriber.thread.is_alive():
            subscriber.thread.join(timeout=2)

    def _spectrum_producer(self, sub: SpectrumSubscriber):
        """Per-subscriber producer thread — reads latest fft_size samples from the rolling buffer
        at the configured frame rate, computes one FFT row in dB, and pushes a binary frame."""
        period = 1.0 / max(sub.frame_rate, 0.1)
        next_tick = time.monotonic()
        while not sub.stop_event.is_set() and not self._stop_event.is_set():
            now = time.monotonic()
            wait = next_tick - now
            if wait > 0:
                time.sleep(min(wait, 0.1))
                continue
            next_tick = now + period

            buf = self._rolling_buffer
            if buf is None or buf.total_written < sub.fft_size:
                continue
            try:
                samples = buf.read_latest(sub.fft_size)
                if samples.size < sub.fft_size:
                    continue
                db = compute_spectrogram_db(samples, sub.fft_size, sub.window)
                if db.shape[0] == 0:
                    continue
                row = np.ascontiguousarray(db[0], dtype=np.float32)
                if sub.dc_remove and row.size > 2 * sub.dc_notch_bins + 2:
                    # Linearly interpolate across ±N bins around DC (center of fft-shifted output).
                    # Display-only: the rolling buffer / snapshots keep the raw IQ.
                    mid = row.size // 2
                    l = mid - sub.dc_notch_bins
                    r = mid + sub.dc_notch_bins
                    left_val = row[l - 1]
                    right_val = row[r + 1]
                    # We want `r - l + 1` values filling row[l:r+1], interpolated between
                    # the neighbors at l-1 and r+1 (exclusive of the endpoints).
                    row[l:r + 1] = np.linspace(left_val, right_val, r - l + 3)[1:-1]
                payload = {
                    "type": "frame",
                    "fft_size": sub.fft_size,
                    "center_freq_hz": self.config.center_freq,
                    "sample_rate_hz": self.config.sample_rate,
                    "timestamp": time.time(),
                    "total_samples": buf.total_written,
                    "_binary": row.tobytes(),
                }
                try:
                    sub.loop.call_soon_threadsafe(sub.queue.put_nowait, payload)
                except Exception:
                    # Loop/queue closed — subscriber is gone
                    break
            except Exception as e:
                logger.warning(f"Spectrum producer error: {e}")

    def add_audio_subscriber(self, subscriber: AudioSubscriber) -> None:
        """Register an audio subscriber and spawn its DSP thread."""
        buf = self._rolling_buffer
        subscriber.last_read_abs = buf.total_written if buf is not None else 0
        subscriber.chain = DemodChain(
            src_rate=self.config.sample_rate,
            monitor_center_hz=self.config.center_freq,
            config=subscriber.config,
        )
        with self._audio_lock:
            self._audio_subscribers.append(subscriber)
        subscriber.thread = threading.Thread(
            target=self._audio_producer,
            args=(subscriber,),
            name=f"audio-{id(subscriber)}",
            daemon=True,
        )
        subscriber.thread.start()

    def remove_audio_subscriber(self, subscriber: AudioSubscriber) -> None:
        subscriber.stop_event.set()
        with self._audio_lock:
            if subscriber in self._audio_subscribers:
                self._audio_subscribers.remove(subscriber)
        if subscriber.thread and subscriber.thread.is_alive():
            subscriber.thread.join(timeout=2)

    def update_audio_config(self, subscriber: AudioSubscriber, cfg: DemodConfig) -> None:
        """Update demod params on a running subscriber without dropping the stream."""
        subscriber.config = cfg
        if subscriber.chain is not None:
            subscriber.chain.update_config(cfg)

    def _audio_producer(self, sub: AudioSubscriber) -> None:
        """Per-subscriber DSP thread. Reads contiguous blocks from the rolling buffer,
        runs the demod chain, pushes int16 PCM to the subscriber's asyncio queue."""
        # Chunk size in source samples — 20 ms at current monitor sample rate
        chunk_dur_s = 0.02
        underrun_logged_at = 0.0
        while not sub.stop_event.is_set() and not self._stop_event.is_set():
            buf = self._rolling_buffer
            if buf is None or sub.chain is None:
                time.sleep(0.01)
                continue

            # Source rate may have changed mid-stream (retune) — update chain if so
            if sub.chain.src_rate != self.config.sample_rate or sub.chain.monitor_center_hz != self.config.center_freq:
                sub.chain.update_monitor(self.config.sample_rate, self.config.center_freq)

            chunk_samples = max(64, int(self.config.sample_rate * chunk_dur_s))
            available = buf.total_written - sub.last_read_abs

            if available < chunk_samples:
                time.sleep(chunk_dur_s / 4)
                continue

            # If we've fallen behind the rolling buffer, skip forward to the newest available
            oldest_valid = max(0, buf.total_written - buf.capacity)
            if sub.last_read_abs < oldest_valid:
                now = time.time()
                if now - underrun_logged_at > 2.0:
                    logger.warning(f"Audio subscriber fell behind rolling buffer by {oldest_valid - sub.last_read_abs} samples")
                    underrun_logged_at = now
                sub.last_read_abs = oldest_valid

            iq = buf.read_range(sub.last_read_abs, chunk_samples)
            sub.last_read_abs += iq.size
            if iq.size == 0:
                continue

            try:
                pcm = sub.chain.process(iq)
            except Exception as e:
                logger.warning(f"Audio producer DSP error: {e}")
                continue

            if pcm.size == 0:
                continue

            payload = {
                "type": "audio",
                "sample_rate": AUDIO_RATE,
                "samples": int(pcm.size),
                "_binary": pcm.tobytes(),
            }
            try:
                sub.loop.call_soon_threadsafe(sub.queue.put_nowait, payload)
            except Exception:
                break

    def snapshot(self, duration_s: float, offset_s: float = 0.0) -> Tuple[np.ndarray, SDRConfig]:
        """Return (samples, config_snapshot) for a window of the rolling buffer.

        The window ends at `now - offset_s` and has length `duration_s`.
        Samples are clipped to what's actually available in the buffer.
        """
        buf = self._rolling_buffer
        cfg_snap = SDRConfig(
            center_freq=self.config.center_freq,
            sample_rate=self.config.sample_rate,
            gain=self.config.gain,
            antenna=getattr(self.config, "antenna", ""),
            bandwidth=getattr(self.config, "bandwidth", 0.0),
        )
        if buf is None:
            return np.array([], dtype=np.complex64), cfg_snap
        sr = self.config.sample_rate
        total = buf.total_written
        end_abs = total - max(0, int(offset_s * sr))
        n = max(0, int(duration_s * sr))
        start_abs = end_abs - n
        samples = buf.read_range(start_abs, n)
        return samples, cfg_snap

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

    def _segments_enabled(self) -> bool:
        return self.segment_duration_s > 0 and self.max_segments > 0

    def _run(self):
        """Main monitor loop — reads SDR in small chunks, feeds the rolling buffer,
        and optionally accumulates chunks into SigMF segments on disk."""
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

            self._rolling_buffer = RollingBuffer(
                sample_rate=self.config.sample_rate,
                window_s=self.rolling_window_s,
            )

            chunk_samples = max(1024, int(self.config.sample_rate * self.chunk_duration_s))
            seg_target = int(self.config.sample_rate * self.segment_duration_s) if self._segments_enabled() else 0
            seg_accum: List[np.ndarray] = []
            seg_accum_n = 0
            segment_index = 0

            while not self._stop_event.is_set():
                # Check for retune commands
                retuned = False
                try:
                    while True:
                        cmd = self._retune_queue.get_nowait()
                        if "center_freq" in cmd:
                            self.config.center_freq = cmd["center_freq"]
                        if "gain" in cmd:
                            self.config.gain = cmd["gain"]
                        if "sample_rate" in cmd:
                            self.config.sample_rate = cmd["sample_rate"]
                            retuned = True
                        device.configure(self.config)
                except queue.Empty:
                    pass
                if retuned:
                    # Sample rate changed — rebuild buffer + recompute chunk sizes, drop any partial segment
                    self._rolling_buffer = RollingBuffer(
                        sample_rate=self.config.sample_rate,
                        window_s=self.rolling_window_s,
                    )
                    chunk_samples = max(1024, int(self.config.sample_rate * self.chunk_duration_s))
                    seg_target = int(self.config.sample_rate * self.segment_duration_s) if self._segments_enabled() else 0
                    seg_accum.clear()
                    seg_accum_n = 0

                # Read one chunk
                try:
                    chunk = device.read_samples(chunk_samples)
                except Exception as e:
                    logger.error(f"Monitor read error: {e}")
                    self._status = "error"
                    self._error = str(e)
                    break

                # Feed rolling buffer (primary data path)
                self._rolling_buffer.write(chunk)

                # Accumulate into a segment only if segments are enabled
                if seg_target > 0:
                    seg_accum.append(chunk)
                    seg_accum_n += len(chunk)
                    if seg_accum_n >= seg_target:
                        samples = np.concatenate(seg_accum)[:seg_target]
                        seg_accum.clear()
                        seg_accum_n = 0

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
            # Notify spectrum subscribers and let their threads exit
            with self._spectrum_lock:
                subs = list(self._spectrum_subscribers)
            for sub in subs:
                sub.stop_event.set()
                try:
                    sub.loop.call_soon_threadsafe(sub.queue.put_nowait, None)
                except Exception:
                    pass
            # Same for audio subscribers
            with self._audio_lock:
                asubs = list(self._audio_subscribers)
            for sub in asubs:
                sub.stop_event.set()
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
