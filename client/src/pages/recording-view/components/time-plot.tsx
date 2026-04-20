import Plot from 'react-plotly.js';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { template } from '@/utils/plotlyTemplate';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';
import { useCursorContext } from '../hooks/use-cursor-context';
import TimePlotWorker from './time-plot.worker.ts?worker';

const MAX_DISPLAY_POINTS = 10_000;
const RELAYOUT_DEBOUNCE_MS = 80;

interface TimePlotProps {
  displayedIQ: Float32Array;
  fftStepSize: Number;
}

interface Trace {
  x: Float32Array;
  I: Float32Array;
  Q: Float32Array;
}

function extractSync(
  iq: Float32Array,
  offset: number,
  length: number,
  freqShift: number | null,
  maxPoints: number
): Trace {
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
  return { x, I, Q };
}

export const TimePlot = ({ displayedIQ, fftStepSize }: TimePlotProps) => {
  const { spectrogramWidth, spectrogramHeight, freqShift } = useSpectrogramContext();
  const { cursorFreqShift } = useCursorContext(); // cursorFreqShift is in normalized freq (-0.5 to +0.5) regardless of if display RF is on
  const [trace, setTrace] = useState<Trace | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const debounceRef = useRef<number | null>(null);
  const viewRef = useRef<[number, number] | null>(null);

  const compute = useCallback(
    (window: [number, number] | null) => {
      if (!displayedIQ || displayedIQ.length === 0) {
        setTrace(null);
        return;
      }
      const nComplex = displayedIQ.length / 2;
      const lo = window ? Math.max(0, Math.floor(window[0])) : 0;
      const hi = window ? Math.min(nComplex, Math.ceil(window[1])) : nComplex;
      const length = Math.max(1, hi - lo);
      const shift = freqShift ? cursorFreqShift : null;

      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }

      // Sync path when the window is already small enough to render directly.
      // Avoids worker spawn latency + postMessage copy for tiny slices (zoomed-in or short selections).
      if (length <= MAX_DISPLAY_POINTS) {
        setTrace(extractSync(displayedIQ, lo, length, shift, MAX_DISPLAY_POINTS));
        return;
      }

      const worker = new TimePlotWorker();
      workerRef.current = worker;
      worker.onmessage = (e: MessageEvent<{ x: ArrayBuffer; I: ArrayBuffer; Q: ArrayBuffer }>) => {
        setTrace({
          x: new Float32Array(e.data.x),
          I: new Float32Array(e.data.I),
          Q: new Float32Array(e.data.Q),
        });
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      };
      worker.postMessage({
        iq: displayedIQ,
        offset: lo,
        length,
        freqShift: shift,
        maxPoints: MAX_DISPLAY_POINTS,
      });
    },
    [displayedIQ, freqShift, cursorFreqShift]
  );

  useEffect(() => {
    viewRef.current = null;
    compute(null);
    return () => {
      if (debounceRef.current != null) clearTimeout(debounceRef.current);
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, [compute]);

  const handleRelayout = useCallback(
    (ev: any) => {
      const nComplex = displayedIQ ? displayedIQ.length / 2 : 0;
      let nextView: [number, number] | null = null;
      if (ev['xaxis.autorange']) {
        nextView = null;
      } else if (ev['xaxis.range[0]'] != null && ev['xaxis.range[1]'] != null) {
        nextView = [ev['xaxis.range[0]'], ev['xaxis.range[1]']];
      } else if (ev['xaxis.range']) {
        nextView = [ev['xaxis.range'][0], ev['xaxis.range'][1]];
      } else {
        return;
      }
      // Ignore spurious relayouts that don't actually change the view span.
      const cur = viewRef.current;
      const same =
        nextView === null
          ? cur === null
          : cur !== null && Math.abs(cur[0] - nextView[0]) < 1 && Math.abs(cur[1] - nextView[1]) < 1;
      if (same) return;
      viewRef.current = nextView;

      if (debounceRef.current != null) clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        // Clamp to data range; if the current view spans the full data, treat as autorange.
        if (nextView && nextView[0] <= 0 && nextView[1] >= nComplex) {
          compute(null);
        } else {
          compute(nextView);
        }
      }, RELAYOUT_DEBOUNCE_MS);
    },
    [compute, displayedIQ]
  );

  return (
    <div className="px-3">
      <p className="text-primary text-center">
        Below shows the time domain of the sample range displayed on the spectrogram tab
      </p>
      {fftStepSize === 0 ? (
        <Plot
          data={[
            { x: trace?.x, y: trace?.I, type: 'scattergl', name: 'I' },
            { x: trace?.x, y: trace?.Q, type: 'scattergl', name: 'Q' },
          ]}
          layout={{
            width: spectrogramWidth,
            height: spectrogramHeight,
            margin: { l: 0, r: 0, b: 0, t: 0, pad: 0 },
            dragmode: 'pan',
            showlegend: true,
            template: template,
            xaxis: { title: 'Time' },
            yaxis: { title: 'Samples', fixedrange: true },
            uirevision: 'true', // keeps zoom/pan the same when data changes
          }}
          config={{
            displayModeBar: true,
            scrollZoom: true,
          }}
          onRelayout={handleRelayout}
        />
      ) : (
        <>
          <h1 className="text-center">Plot only visible when Zoom Out Level is minimum (0)</h1>
          <p className="text-primary text-center mb-6">(Otherwise the IQ samples are not contiguous)</p>
        </>
      )}
    </div>
  );
};
