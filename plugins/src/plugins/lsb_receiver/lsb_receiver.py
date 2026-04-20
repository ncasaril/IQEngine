import base64
import io

import numpy as np
from models.models import DataObject, Output
from models.plugin import Plugin
from scipy import signal
from scipy.io.wavfile import write

AUDIO_RATE = 48_000


class lsb_receiver(Plugin):
    """Lower-sideband SSB demodulator. Tune target_freq so the suppressed
    carrier sits at the upper edge of the audio band (just above the signal).
    Internally conjugates the baseband so the LSB ends up on the positive side
    and the same real-part demod as USB applies."""

    sample_rate: int = 0
    center_freq: int = 0

    # custom params
    target_freq: float = 0.0
    audio_bandwidth: float = 3_000.0
    gain: float = 1.0

    def rf_function(self, samples, job_context=None):
        if self.target_freq != 0:
            samples = samples * np.exp(
                -2j * np.pi * self.target_freq * np.arange(len(samples)) / self.sample_rate
            )

        # Flip spectrum so the LSB content lands on positive frequencies
        samples = np.conj(samples)

        h = signal.firwin(201, cutoff=self.audio_bandwidth, fs=self.sample_rate).astype(np.complex64)
        samples = np.convolve(samples, h, "valid")

        up, down = AUDIO_RATE, int(self.sample_rate)
        g = np.gcd(up, down)
        samples = signal.resample_poly(samples, up // g, down // g)

        audio = np.real(samples).astype(np.float64)
        audio = audio - np.mean(audio)

        peak = np.max(np.abs(audio))
        if peak > 0:
            audio = audio / peak
        audio = np.clip(audio * self.gain, -1.0, 1.0)
        audio = (audio * 32767).astype(np.int16)

        byte_io = io.BytesIO()
        write(byte_io, AUDIO_RATE, audio)

        return Output(
            non_iq_output_data=DataObject(
                data_type="audio/wav",
                file_name="output.wav",
                data=base64.b64encode(byte_io.getvalue()).decode(),
            )
        )
