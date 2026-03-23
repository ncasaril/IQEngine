"""Signal detection and analysis for the Agent API."""

import logging
from typing import List, Optional, Tuple

import numpy as np

from helpers.spectrogram_engine import compute_spectrogram_db

logger = logging.getLogger("api")


def estimate_noise_floor(magnitudes_db: np.ndarray) -> float:
    """Estimate the noise floor using the median of the spectrogram.

    The median is a robust estimator since most of the spectrum is typically noise.
    """
    return float(np.median(magnitudes_db))


def detect_signals(
    samples: np.ndarray,
    fft_size: int,
    sample_rate: float,
    center_freq: float,
    threshold_db: float = 10.0,
    min_bandwidth_bins: int = 3,
    window: str = "hanning",
) -> Tuple[List[dict], dict]:
    """Detect signals above noise floor in IQ samples.

    Args:
        samples: Complex64 IQ samples
        fft_size: FFT size
        sample_rate: Sample rate in Hz
        center_freq: Center frequency in Hz
        threshold_db: Detection threshold above noise floor in dB
        min_bandwidth_bins: Minimum number of contiguous bins to count as signal
        window: Window function

    Returns:
        Tuple of (list of detected signals, summary dict)
    """
    if len(samples) < fft_size:
        return [], {"noise_floor_db": 0.0, "num_signals_detected": 0, "occupied_bandwidth_hz": 0.0}

    # Compute spectrogram
    db = compute_spectrogram_db(samples, fft_size, window)
    if db.shape[0] == 0:
        return [], {"noise_floor_db": 0.0, "num_signals_detected": 0, "occupied_bandwidth_hz": 0.0}

    # Average across time to get mean power spectrum
    mean_spectrum = np.mean(db, axis=0)

    noise_floor = estimate_noise_floor(db)
    threshold = noise_floor + threshold_db

    # Find bins above threshold
    above = mean_spectrum > threshold

    # Find connected regions (contiguous bins above threshold)
    signals = []
    freq_resolution = sample_rate / fft_size
    freq_start = center_freq - sample_rate / 2

    in_signal = False
    region_start = 0
    for i in range(len(above)):
        if above[i] and not in_signal:
            region_start = i
            in_signal = True
        elif not above[i] and in_signal:
            if i - region_start >= min_bandwidth_bins:
                peak_bin = region_start + np.argmax(mean_spectrum[region_start:i])
                signals.append({
                    "freq_lower_hz": freq_start + region_start * freq_resolution,
                    "freq_upper_hz": freq_start + i * freq_resolution,
                    "peak_power_db": float(mean_spectrum[peak_bin]),
                    "bandwidth_hz": (i - region_start) * freq_resolution,
                    "center_freq_hz": freq_start + (region_start + i) / 2 * freq_resolution,
                    "time_start_s": 0.0,
                    "time_stop_s": len(samples) / sample_rate,
                })
            in_signal = False

    # Handle signal at edge
    if in_signal and len(above) - region_start >= min_bandwidth_bins:
        i = len(above)
        peak_bin = region_start + np.argmax(mean_spectrum[region_start:i])
        signals.append({
            "freq_lower_hz": freq_start + region_start * freq_resolution,
            "freq_upper_hz": freq_start + i * freq_resolution,
            "peak_power_db": float(mean_spectrum[peak_bin]),
            "bandwidth_hz": (i - region_start) * freq_resolution,
            "center_freq_hz": freq_start + (region_start + i) / 2 * freq_resolution,
            "time_start_s": 0.0,
            "time_stop_s": len(samples) / sample_rate,
        })

    occupied_bw = sum(s["bandwidth_hz"] for s in signals)

    summary = {
        "noise_floor_db": float(noise_floor),
        "num_signals_detected": len(signals),
        "occupied_bandwidth_hz": occupied_bw,
    }

    return signals, summary
