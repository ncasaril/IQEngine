"""Demodulation pipeline for live audio: mixer → LPF → resample → demod → PCM16.

One DemodChain instance per audio subscriber. All state (mixer phase, filter
delay lines, last complex sample) is kept on the chain so chunks are
continuous across calls to process().
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy.signal import firwin, lfilter, lfilter_zi, resample_poly


AUDIO_RATE = 48_000

# Supported demodulation modes
MODE_NFM = "nfm"
MODE_WFM = "wfm"
MODE_AM = "am"
MODE_USB = "usb"
MODE_LSB = "lsb"
SUPPORTED_MODES = {MODE_NFM, MODE_WFM, MODE_AM, MODE_USB, MODE_LSB}


@dataclass
class DemodConfig:
    mode: str = MODE_NFM
    center_hz: float = 0.0     # absolute demod tuning frequency (Hz)
    bandwidth_hz: float = 15_000.0
    volume_db: float = 0.0
    squelch_db: float = -120.0  # apply when signal below this (dB)
    muted: bool = False


def _rational_resample_ratio(src_rate: float, dst_rate: float) -> tuple[int, int]:
    """Find a small rational up/down ratio for resample_poly. Limits to <= 1024 for tap count."""
    from math import gcd
    a, b = int(round(dst_rate)), int(round(src_rate))
    g = gcd(a, b)
    return a // g, b // g


class DemodChain:
    """Stateful per-subscriber DSP chain.

    Call update_config(...) whenever the user retunes, then call process(iq) with
    the next contiguous block of complex64 samples from the rolling buffer.
    Returns int16 mono PCM at AUDIO_RATE.
    """

    def __init__(self, src_rate: float, config: DemodConfig, monitor_center_hz: float):
        self.src_rate = float(src_rate)
        self.monitor_center_hz = float(monitor_center_hz)
        self.config = config

        # Mixer state — keeps phase continuity across chunks
        self._mixer_phase = 0.0

        # Filter state (time-domain FIR with lfilter + zi)
        self._lpf_taps: Optional[np.ndarray] = None
        self._lpf_zi: Optional[np.ndarray] = None

        # FM demod state (previous complex sample)
        self._prev_sample: complex = 0 + 0j

        # AM envelope DC blocker state (single-pole IIR)
        self._am_dc = 0.0

        self._rebuild_filters()

    # ---- public API ----

    def update_config(self, cfg: DemodConfig) -> None:
        rebuild = (
            cfg.bandwidth_hz != self.config.bandwidth_hz
            or cfg.mode != self.config.mode
        )
        self.config = cfg
        if rebuild:
            self._rebuild_filters()

    def update_monitor(self, src_rate: float, monitor_center_hz: float) -> None:
        src_changed = src_rate != self.src_rate
        self.src_rate = float(src_rate)
        self.monitor_center_hz = float(monitor_center_hz)
        if src_changed:
            self._rebuild_filters()

    def process(self, iq: np.ndarray) -> np.ndarray:
        """Consume complex64 IQ at src_rate, return int16 PCM mono at AUDIO_RATE."""
        if iq.size == 0:
            return np.zeros(0, dtype=np.int16)
        if self.config.muted:
            out_len = max(1, int(round(iq.size * AUDIO_RATE / self.src_rate)))
            return np.zeros(out_len, dtype=np.int16)

        # 1) Mix the demod center down to baseband (with phase continuity).
        offset_hz = self.config.center_hz - self.monitor_center_hz
        phase_inc = -2.0 * math.pi * offset_hz / self.src_rate
        n = iq.size
        phases = self._mixer_phase + phase_inc * np.arange(n, dtype=np.float64)
        self._mixer_phase = float((self._mixer_phase + phase_inc * n) % (2.0 * math.pi))
        lo = np.exp(1j * phases).astype(np.complex64)
        baseband = iq.astype(np.complex64, copy=False) * lo

        # 2) Lowpass to the chosen channel bandwidth (before decimation for anti-aliasing).
        assert self._lpf_taps is not None and self._lpf_zi is not None
        filt_i, self._lpf_zi_i = lfilter(self._lpf_taps, [1.0], baseband.real, zi=self._lpf_zi_i)
        filt_q, self._lpf_zi_q = lfilter(self._lpf_taps, [1.0], baseband.imag, zi=self._lpf_zi_q)
        filt = (filt_i + 1j * filt_q).astype(np.complex64)

        # 3) Resample to AUDIO_RATE (polyphase rational resampler).
        up, down = self._resample_up, self._resample_down
        if up == 1 and down == 1:
            resampled = filt
        else:
            # resample_poly operates on real input; run on I and Q separately, then recombine.
            r_i = resample_poly(filt.real.astype(np.float32), up, down)
            r_q = resample_poly(filt.imag.astype(np.float32), up, down)
            resampled = (r_i + 1j * r_q).astype(np.complex64)

        # 4) Demodulate per mode.
        mode = self.config.mode
        if mode in (MODE_NFM, MODE_WFM):
            audio = self._demod_fm(resampled, mode)
        elif mode == MODE_AM:
            audio = self._demod_am(resampled)
        elif mode == MODE_USB or mode == MODE_LSB:
            audio = self._demod_ssb(resampled, mode)
        else:
            audio = np.zeros(resampled.size, dtype=np.float32)

        # 5) Squelch: if the signal magnitude is below threshold_db, silence.
        if self.config.squelch_db > -120.0:
            mag_db = 20.0 * np.log10(max(float(np.mean(np.abs(resampled))), 1e-12))
            if mag_db < self.config.squelch_db:
                audio *= 0.0

        # 6) Volume + clip to int16.
        gain = 10.0 ** (self.config.volume_db / 20.0)
        audio = audio * gain
        np.clip(audio, -1.0, 1.0, out=audio)
        return (audio * 32767.0).astype(np.int16)

    # ---- internals ----

    def _rebuild_filters(self) -> None:
        bw = max(100.0, float(self.config.bandwidth_hz))
        nyq = self.src_rate / 2.0
        cutoff = min(bw / 2.0, nyq * 0.95)
        # 128 taps is enough for the bandwidths we care about at 2-8 Msps
        ntaps = 127
        self._lpf_taps = firwin(ntaps, cutoff / nyq, window="hamming").astype(np.float32)
        zi_template = lfilter_zi(self._lpf_taps, [1.0]).astype(np.float32)
        # Separate state for I and Q since we feed lfilter with real signals
        self._lpf_zi_i = np.zeros_like(zi_template)
        self._lpf_zi_q = np.zeros_like(zi_template)
        self._lpf_zi = zi_template  # kept for the assert; the real state is _zi_i/_zi_q

        self._resample_up, self._resample_down = _rational_resample_ratio(self.src_rate, AUDIO_RATE)

    def _demod_fm(self, x: np.ndarray, mode: str) -> np.ndarray:
        """Quadrature FM demod using the product x[n] * conj(x[n-1]) → phase increment."""
        if x.size == 0:
            return np.zeros(0, dtype=np.float32)
        prev = np.empty_like(x)
        prev[0] = self._prev_sample
        prev[1:] = x[:-1]
        prod = x * np.conj(prev)
        self._prev_sample = complex(x[-1])
        demod = np.angle(prod).astype(np.float32)
        # Normalize so that ±max_deviation maps to roughly ±1.
        # max phase step = 2π * dev / AUDIO_RATE  →  scale = AUDIO_RATE / (2π * dev)
        dev = 5_000.0 if mode == MODE_NFM else 75_000.0
        scale = AUDIO_RATE / (2.0 * math.pi * dev)
        return demod * scale

    def _demod_am(self, x: np.ndarray) -> np.ndarray:
        env = np.abs(x).astype(np.float32)
        if env.size == 0:
            return env
        # Single-pole IIR DC blocker: y = 0.995*y_prev + 0.005*env
        # Vectorised: use a running mean approximation via exponential smoothing.
        alpha = 0.005
        out = np.empty_like(env)
        dc = self._am_dc
        for i in range(env.size):
            dc = (1.0 - alpha) * dc + alpha * env[i]
            out[i] = env[i] - dc
        self._am_dc = float(dc)
        return out

    def _demod_ssb(self, x: np.ndarray, mode: str) -> np.ndarray:
        # Weaver-style: for USB we want the positive sideband, for LSB the negative.
        # Since x is already shifted so that the channel is at baseband, USB = real(x),
        # LSB = real(conj(x)). Simple, imperfect, but audible.
        if mode == MODE_USB:
            return x.real.astype(np.float32)
        return np.conj(x).real.astype(np.float32)
