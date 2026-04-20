/// <reference lib="webworker" />

interface Msg {
  iq: Float32Array;
  offset: number;
  length: number;
  sampleRate: number;
  freqShiftHz: number;
  ifBandwidthHz: number;
  targetRate: number;
  maxPoints: number;
  timeOffsetS: number;
}

const NUMTAPS = 101;

function designLowpass(numtaps: number, cutoffHz: number, sampleRate: number): Float32Array {
  const taps = new Float32Array(numtaps);
  const fc = cutoffHz / sampleRate;
  const mid = (numtaps - 1) / 2;
  let sum = 0;
  for (let n = 0; n < numtaps; n++) {
    const m = n - mid;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (numtaps - 1));
    taps[n] = sinc * w;
    sum += taps[n];
  }
  if (sum > 0) for (let i = 0; i < numtaps; i++) taps[i] /= sum;
  return taps;
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const { iq, offset, length, sampleRate, freqShiftHz, ifBandwidthHz, targetRate, maxPoints, timeOffsetS } = e.data;

  const nIn = Math.min(Math.floor(iq.length / 2) - offset, length);
  if (nIn <= NUMTAPS + 2 || sampleRate <= 0) {
    (self as unknown as Worker).postMessage({
      t: new Float32Array(0).buffer,
      am: new Float32Array(0).buffer,
      fm: new Float32Array(0).buffer,
      actualRate: 0,
    }, []);
    return;
  }

  // Integer decimation factor to land close to targetRate.
  const M = Math.max(1, Math.round(sampleRate / Math.max(1, targetRate)));
  const actualRate = sampleRate / M;

  // Shift + LPF cut proportional to the IF bandwidth, clamped to the post-decimation Nyquist.
  const cutoff = Math.min(ifBandwidthHz / 2, actualRate * 0.45);
  const taps = designLowpass(NUMTAPS, cutoff, sampleRate);

  // Step 1: freq-shift into a contiguous buffer. Incremental phase accumulator.
  const shiftedI = new Float32Array(nIn);
  const shiftedQ = new Float32Array(nIn);
  if (freqShiftHz !== 0) {
    const dPhase = (-2 * Math.PI * freqShiftHz) / sampleRate;
    let phase = dPhase * offset;
    for (let i = 0; i < nIn; i++) {
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      const re = iq[(offset + i) * 2];
      const im = iq[(offset + i) * 2 + 1];
      shiftedI[i] = re * c - im * s;
      shiftedQ[i] = re * s + im * c;
      phase += dPhase;
    }
  } else {
    for (let i = 0; i < nIn; i++) {
      shiftedI[i] = iq[(offset + i) * 2];
      shiftedQ[i] = iq[(offset + i) * 2 + 1];
    }
  }

  // Step 2: FIR + decimate by M (valid convolution).
  const nFilt = Math.floor((nIn - NUMTAPS + 1) / M);
  if (nFilt < 2) {
    (self as unknown as Worker).postMessage({
      t: new Float32Array(0).buffer,
      am: new Float32Array(0).buffer,
      fm: new Float32Array(0).buffer,
      actualRate,
    }, []);
    return;
  }
  const dI = new Float32Array(nFilt);
  const dQ = new Float32Array(nFilt);
  for (let k = 0; k < nFilt; k++) {
    const base = k * M;
    let accI = 0, accQ = 0;
    for (let t = 0; t < NUMTAPS; t++) {
      const tap = taps[t];
      accI += tap * shiftedI[base + t];
      accQ += tap * shiftedQ[base + t];
    }
    dI[k] = accI;
    dQ[k] = accQ;
  }

  // Step 3: AM envelope + FM discriminator (at actualRate).
  const am = new Float32Array(nFilt);
  for (let k = 0; k < nFilt; k++) am[k] = Math.hypot(dI[k], dQ[k]);

  // FM: unwrap(angle(x)), then diff, scale to Hz.
  const phase = new Float32Array(nFilt);
  {
    let last = Math.atan2(dQ[0], dI[0]);
    phase[0] = last;
    let acc = last;
    for (let k = 1; k < nFilt; k++) {
      const cur = Math.atan2(dQ[k], dI[k]);
      let d = cur - last;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      acc += d;
      phase[k] = acc;
      last = cur;
    }
  }
  const nFm = nFilt - 1;
  const fm = new Float32Array(nFm);
  const hzScale = actualRate / (2 * Math.PI);
  for (let k = 0; k < nFm; k++) fm[k] = (phase[k + 1] - phase[k]) * hzScale;

  // Step 4: stride-decimate to maxPoints for display.
  const nOut = Math.min(maxPoints, nFm);
  const stride = Math.max(1, Math.ceil(nFm / nOut));
  const outCount = Math.ceil(nFm / stride);
  const tOut = new Float32Array(outCount);
  const amOut = new Float32Array(outCount);
  const fmOut = new Float32Array(outCount);
  const dt = M / sampleRate;
  for (let k = 0; k < outCount; k++) {
    const idx = k * stride;
    tOut[k] = timeOffsetS + idx * dt;
    amOut[k] = am[idx];
    fmOut[k] = fm[idx];
  }

  (self as unknown as Worker).postMessage(
    {
      t: tOut.buffer,
      am: amOut.buffer,
      fm: fmOut.buffer,
      actualRate,
    },
    [tOut.buffer, amOut.buffer, fmOut.buffer]
  );
};
