/// <reference lib="webworker" />

interface Msg {
  iq: Float32Array;
  offset: number;
  length: number;
  freqShift: number | null;
  maxPoints: number;
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const { iq, offset, length, freqShift, maxPoints } = e.data;
  const nComplex = Math.min(iq.length / 2 - offset, length);
  const stride = Math.max(1, Math.ceil(nComplex / maxPoints));
  const nOut = Math.ceil(nComplex / stride);

  const x = new Float32Array(nOut);
  const I = new Float32Array(nOut);
  const Q = new Float32Array(nOut);

  if (freqShift != null) {
    const w = -2 * Math.PI * freqShift;
    for (let k = 0; k < nOut; k++) {
      const i = offset + k * stride;
      const re = iq[i * 2];
      const im = iq[i * 2 + 1];
      const c = Math.cos(w * i);
      const s = Math.sin(w * i);
      x[k] = i;
      I[k] = re * c - im * s;
      Q[k] = re * s + im * c;
    }
  } else {
    for (let k = 0; k < nOut; k++) {
      const i = offset + k * stride;
      x[k] = i;
      I[k] = iq[i * 2];
      Q[k] = iq[i * 2 + 1];
    }
  }

  (self as unknown as Worker).postMessage(
    { x: x.buffer, I: I.buffer, Q: Q.buffer },
    [x.buffer, I.buffer, Q.buffer]
  );
};
