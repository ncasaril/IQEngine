import base64
import io

import numpy as np
from models.models import DataObject, Output
from models.plugin import Plugin
from scipy import signal
from scipy.io.wavfile import write

AUDIO_RATE = 48_000


class nfm_receiver(Plugin):
    sample_rate: int = 0
    center_freq: int = 0

    # custom params
    target_freq: float = 0.0  # Hz offset from center, where to tune within the IQ
    if_bandwidth: float = 15_000.0  # NFM channel IF bandwidth (±7.5 kHz typical)
    gain: float = 1.0

    def rf_function(self, samples, job_context=None):
        if self.target_freq != 0:
            samples = samples * np.exp(
                -2j * np.pi * self.target_freq * np.arange(len(samples)) / self.sample_rate
            )

        lpf_cutoff = self.if_bandwidth / 2.0
        h = signal.firwin(101, cutoff=lpf_cutoff, fs=self.sample_rate).astype(np.complex64)
        samples = np.convolve(samples, h, "valid")

        # Resample IQ down to 4 * AUDIO_RATE for stable FM demod headroom
        intermediate_rate = AUDIO_RATE * 4
        up = intermediate_rate
        down = int(self.sample_rate)
        g = np.gcd(up, down)
        samples = signal.resample_poly(samples, up // g, down // g)

        # FM discriminator
        audio = np.diff(np.unwrap(np.angle(samples)))

        # Decimate from intermediate_rate to AUDIO_RATE
        audio = signal.resample_poly(audio, 1, intermediate_rate // AUDIO_RATE)

        # Simple DC block + normalize + gain + clip
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
