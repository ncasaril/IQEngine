import Plot from 'react-plotly.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { template } from '@/utils/plotlyTemplate';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';
import { useCursorContext } from '../hooks/use-cursor-context';
import DemodPlotWorker from './demod-plot.worker.ts?worker';

const MAX_DISPLAY_POINTS = 10_000;
const MAX_INPUT_COMPLEX = 5_000_000;
const TARGET_DISPLAY_RATE = 48_000;
const BW_OPTIONS = [
  { label: '5 kHz', value: 5_000 },
  { label: '15 kHz', value: 15_000 },
  { label: '50 kHz', value: 50_000 },
  { label: '200 kHz', value: 200_000 },
  { label: '500 kHz', value: 500_000 },
];

interface DemodPlotProps {
  displayedIQ: Float32Array;
  fftStepSize: Number;
}

interface Trace {
  t: Float32Array;
  am: Float32Array;
  fm: Float32Array;
  actualRate: number;
}

export const DemodPlot = ({ displayedIQ, fftStepSize }: DemodPlotProps) => {
  const { spectrogramWidth, spectrogramHeight, freqShift, effectiveSampleRateHz } = useSpectrogramContext();
  const { cursorFreqShift, cursorData, cursorTime, cursorTimeEnabled } = useCursorContext();
  const [ifBandwidthHz, setIfBandwidthHz] = useState<number>(15_000);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const useCursorWindow = cursorTimeEnabled && cursorData && cursorData.length > 0;
  const sampleRate = effectiveSampleRateHz;
  const freqShiftHz = freqShift ? cursorFreqShift * sampleRate : 0;

  const source = useMemo<{
    iq: Float32Array;
    length: number;
    timeOffsetS: number;
    note: string | null;
  } | null>(() => {
    if (useCursorWindow) {
      const length = cursorData.length / 2;
      return {
        iq: cursorData,
        length,
        timeOffsetS: sampleRate > 0 ? cursorTime.start / sampleRate : 0,
        note: null,
      };
    }
    if (fftStepSize !== 0) {
      return null;
    }
    if (!displayedIQ || displayedIQ.length === 0) {
      return null;
    }
    return {
      iq: displayedIQ,
      length: displayedIQ.length / 2,
      timeOffsetS: 0,
      note: 'Showing current spectrogram window. Enable a Time cursor for a specific selection.',
    };
  }, [useCursorWindow, cursorData, cursorTime.start, fftStepSize, displayedIQ, sampleRate]);

  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    if (!source || sampleRate <= 0) {
      setTrace(null);
      return;
    }
    if (source.length > MAX_INPUT_COMPLEX) {
      setErr(`Selection is ${source.length.toLocaleString()} samples — cap is ${MAX_INPUT_COMPLEX.toLocaleString()}. Narrow the cursor.`);
      setTrace(null);
      return;
    }
    setErr(null);

    const worker = new DemodPlotWorker();
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<{ t: ArrayBuffer; am: ArrayBuffer; fm: ArrayBuffer; actualRate: number }>) => {
      setTrace({
        t: new Float32Array(e.data.t),
        am: new Float32Array(e.data.am),
        fm: new Float32Array(e.data.fm),
        actualRate: e.data.actualRate,
      });
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.postMessage({
      iq: source.iq,
      offset: 0,
      length: source.length,
      sampleRate,
      freqShiftHz,
      ifBandwidthHz,
      targetRate: TARGET_DISPLAY_RATE,
      maxPoints: MAX_DISPLAY_POINTS,
      timeOffsetS: source.timeOffsetS,
    });
    return () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
  }, [source, sampleRate, freqShiftHz, ifBandwidthHz]);

  if (fftStepSize !== 0 && !useCursorWindow) {
    return (
      <div className="px-3">
        <h1 className="text-center">Demod view needs contiguous samples</h1>
        <p className="text-primary text-center mb-6">
          Set Zoom Out Level to 0, or draw a Time cursor on the spectrogram.
        </p>
      </div>
    );
  }

  const hasTrace = trace && trace.t.length > 0;
  const fmKhz = hasTrace ? Array.from(trace.fm).map((v) => v / 1000) : [];

  return (
    <div className="px-3">
      <div className="flex flex-row items-center gap-4 justify-center mb-2 text-primary">
        <span>
          Source: {useCursorWindow ? 'time cursor' : 'spectrogram window'}
          {source?.note ? <em className="text-sm opacity-70"> — {source.note}</em> : null}
        </span>
        <span>
          Shift: {freqShift ? `${(freqShiftHz / 1000).toFixed(1)} kHz (cursor)` : 'off'}
        </span>
        <label className="flex items-center gap-2">
          IF BW:
          <select
            className="bg-base-100 border border-primary px-2 py-0.5"
            value={ifBandwidthHz}
            onChange={(e) => setIfBandwidthHz(parseInt(e.target.value, 10))}
          >
            {BW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {hasTrace ? (
          <span className="text-sm opacity-70">
            post-decim rate: {(trace!.actualRate / 1000).toFixed(1)} kHz
          </span>
        ) : null}
      </div>
      {err ? (
        <div className="text-center text-error">{err}</div>
      ) : hasTrace ? (
        <Plot
          data={[
            {
              x: Array.from(trace!.t),
              y: Array.from(trace!.am),
              type: 'scattergl',
              mode: 'lines',
              name: 'AM |x|',
              xaxis: 'x',
              yaxis: 'y',
            },
            {
              x: Array.from(trace!.t.slice(0, trace!.fm.length)),
              y: fmKhz,
              type: 'scattergl',
              mode: 'lines',
              name: 'FM (kHz)',
              xaxis: 'x',
              yaxis: 'y2',
            },
          ]}
          layout={{
            width: spectrogramWidth,
            height: spectrogramHeight,
            margin: { l: 50, r: 10, b: 40, t: 10, pad: 0 },
            dragmode: 'pan',
            showlegend: false,
            template: template,
            grid: { rows: 2, columns: 1, pattern: 'independent' },
            xaxis: { title: 'Time (s)', anchor: 'y2' },
            yaxis: { title: 'AM envelope', domain: [0.55, 1] },
            yaxis2: { title: 'FM inst. freq (kHz)', domain: [0, 0.45], anchor: 'x' },
            uirevision: 'demod',
          }}
          config={{
            displayModeBar: true,
            scrollZoom: true,
          }}
        />
      ) : (
        <p className="text-primary text-center">Computing…</p>
      )}
    </div>
  );
};
