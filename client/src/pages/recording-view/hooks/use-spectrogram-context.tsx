import { useDataCacheFunctions } from '@/api/iqdata/Queries';
import { useMeta } from '@/api/metadata/queries';
import { INITIAL_PYTHON_SNIPPET } from '@/utils/constants';
import { SigMFMetadata } from '@/utils/sigmfMetadata';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { COLORMAP_DEFAULT } from '@/utils/constants';

interface SpectrogramContextProperties {
  type: string;
  account: string;
  container: string;
  filePath: string;
  magnitudeMin: number;
  setMagnitudeMin: (magnitudeMin: number) => void;
  magnitudeMax: number;
  setMagnitudeMax: (magnitudeMax: number) => void;
  colmap: string;
  setColmap: (colmap: string) => void;
  windowFunction: string;
  setWindowFunction: (windowFunction: string) => void;
  fftSize: number;
  setFFTSize: (fftSize: number) => void;
  spectrogramHeight: number;
  setSpectrogramHeight: (spectrogramHeight: number) => void;
  spectrogramWidth: number;
  setSpectrogramWidth: (spectrogramWidth: number) => void;
  fftStepSize: number;
  setFFTStepSize: (fftStepSize: number) => void;
  includeRfFreq: boolean;
  setIncludeRfFreq: (includeRfFreq: boolean) => void;
  squareSignal: boolean;
  setSquareSignal: (squareSignal: boolean) => void;
  freqShift: boolean;
  setFreqShift: (freqShift: boolean) => void;
  taps: number[];
  setTaps: (taps: number[]) => void;
  pythonSnippet: string;
  setPythonSnippet: (pythonSnippet: string) => void;
  meta: SigMFMetadata;
  setMeta: (meta: SigMFMetadata) => void;
  canDownload: boolean;
  setCanDownload: (canDownload: boolean) => void;
  selectedAnnotation?: number;
  setSelectedAnnotation: (selectedAnnotation: number) => void;
  serverSideFFT: boolean;
  setServerSideFFT: (serverSideFFT: boolean) => void;
  // Freq-zoom state: when freqZoomBandwidthHz > 0, the spectrogram is rendered from
  // IQ decimated by (originalSampleRate / nextPowerOfTwo(freqZoomBandwidthHz)) and
  // mixed to put freqZoomCenterHz at DC. Null means no zoom (full span).
  freqZoomCenterHz: number | null;
  freqZoomBandwidthHz: number | null;
  setFreqZoom: (params: { centerHz: number; bandwidthHz: number } | null) => void;
  // Effective values after freq zoom: sample rate = file_sr / zoom_decimation,
  // center = freqZoomCenterHz. Consumers (freq cursor labels, plugin target_freq,
  // ruler-top, etc.) should use these instead of raw meta for cursor→Hz math so
  // they agree with the displayed spectrum.
  effectiveSampleRateHz: number;
  effectiveCenterFreqHz: number;
  // Time-axis zoom-in factor (1, 2, 4, 8...). 1 = 1:1 pixel-per-source-row. >1 =
  // each source FFT row is stretched across multiple pixels. fftStepSize and
  // timeZoomIn are mutually exclusive — setting timeZoomIn > 1 forces
  // fftStepSize to 0 so the viewport shows a shorter segment in higher detail.
  timeZoomIn: number;
  setTimeZoomIn: (v: number) => void;
  showAnnotations: boolean;
  setShowAnnotations: (v: boolean) => void;
}

export const SpectrogramContext = createContext<SpectrogramContextProperties>(null);

// Initial settings
export function SpectrogramContextProvider({
  children,
  type,
  account,
  container,
  filePath,
  seedValues = {
    magnitudeMin: -150,
    magnitudeMax: 0,
    colmap: COLORMAP_DEFAULT,
    windowFunction: 'rectangle',
    fftSize: 1024,
    spectrogramHeight: 800,
    spectrogramWidth: 1024,
    fftStepSize: 0,
  },
}) {
  const [magnitudeMin, setMagnitudeMin] = useState<number>(seedValues.magnitudeMin);
  const [magnitudeMax, setMagnitudeMax] = useState<number>(seedValues.magnitudeMax);
  const [colmap, setColmap] = useState<string>(seedValues.colmap);
  const [windowFunction, setWindowFunction] = useState<string>(seedValues.windowFunction);
  const [fftSize, setFFTSize] = useState<number>(seedValues.fftSize);
  const [spectrogramHeight, setSpectrogramHeight] = useState<number>(seedValues.spectrogramHeight);
  const [spectrogramWidth, setSpectrogramWidth] = useState<number>(seedValues.spectrogramWidth);
  const [fftStepSize, setFFTStepSize] = useState<number>(seedValues.fftStepSize);
  const [includeRfFreq, setIncludeRfFreq] = useState<boolean>(false);
  const [squareSignal, setSquareSignal] = useState<boolean>(false);
  const [freqShift, setFreqShift] = useState<boolean>(false);
  const [taps, setTaps] = useState<number[]>([1]);
  const [pythonSnippet, setPythonLocalSnippet] = useState<string>(INITIAL_PYTHON_SNIPPET);
  const { data: originMeta } = useMeta(type, account, container, filePath);
  const [meta, setMeta] = useState<SigMFMetadata>(originMeta);
  const [canDownload, setCanDownload] = useState<boolean>(false);
  const [selectedAnnotation, setSelectedAnnotation] = useState<number>();
  const [serverSideFFT, setServerSideFFT] = useState<boolean>(false);
  const [freqZoomCenterHz, setFreqZoomCenterHz] = useState<number | null>(null);
  const [freqZoomBandwidthHz, setFreqZoomBandwidthHz] = useState<number | null>(null);
  const [timeZoomIn, setTimeZoomIn] = useState<number>(1);
  const [showAnnotations, setShowAnnotations] = useState<boolean>(true);
  const setFreqZoom = (params: { centerHz: number; bandwidthHz: number } | null) => {
    if (!params) {
      setFreqZoomCenterHz(null);
      setFreqZoomBandwidthHz(null);
    } else {
      setFreqZoomCenterHz(params.centerHz);
      setFreqZoomBandwidthHz(params.bandwidthHz);
    }
  };
  const fileSampleRate = meta?.getSampleRate?.() || 0;
  const fileCenter = meta?.getCenterFrequency?.() || 0;
  let effectiveSampleRateHz = fileSampleRate;
  let effectiveCenterFreqHz = fileCenter;
  if (freqZoomBandwidthHz && freqZoomCenterHz != null && fileSampleRate > 0 && freqZoomBandwidthHz < fileSampleRate) {
    // Match the server's zoom_decimation_factor: next power-of-two ratio of SR to BW
    const ratio = fileSampleRate / freqZoomBandwidthHz;
    const decimation = Math.max(1, 2 ** Math.ceil(Math.log2(ratio)));
    effectiveSampleRateHz = fileSampleRate / decimation;
    effectiveCenterFreqHz = freqZoomCenterHz;
  }
  const { clearIQData } = useDataCacheFunctions(type, account, container, filePath, fftSize);

  function setPythonSnippet(pythonParameterSnippet: string) {
    clearIQData();
    setPythonLocalSnippet(pythonParameterSnippet);
  }

  useEffect(() => {
    setMeta(originMeta);

    // If the recording size is real small, lower FFT size so it fills out vertically better
    if (meta && meta.getTotalSamples() < 100e3) {
      setFFTSize(256);
    }

    // Auto-enable server-side FFT for large recordings (>10M samples)
    if (meta && meta.getTotalSamples() > 10e6 && type !== 'local') {
      setServerSideFFT(true);
    }
  }, [originMeta]);

  return (
    <SpectrogramContext.Provider
      value={{
        type,
        account,
        container,
        filePath,
        magnitudeMin,
        setMagnitudeMin,
        magnitudeMax,
        setMagnitudeMax,
        colmap,
        setColmap,
        windowFunction,
        setWindowFunction,
        fftSize,
        setFFTSize,
        spectrogramHeight,
        setSpectrogramHeight,
        spectrogramWidth,
        setSpectrogramWidth,
        fftStepSize,
        setFFTStepSize,
        includeRfFreq,
        setIncludeRfFreq,
        squareSignal,
        setSquareSignal,
        freqShift,
        setFreqShift,
        taps,
        setTaps,
        pythonSnippet,
        setPythonSnippet,
        meta,
        setMeta,
        canDownload,
        setCanDownload,
        selectedAnnotation,
        setSelectedAnnotation,
        serverSideFFT,
        setServerSideFFT,
        freqZoomCenterHz,
        freqZoomBandwidthHz,
        setFreqZoom,
        effectiveSampleRateHz,
        effectiveCenterFreqHz,
        timeZoomIn,
        setTimeZoomIn,
        showAnnotations,
        setShowAnnotations,
      }}
    >
      {children}
    </SpectrogramContext.Provider>
  );
}

export function useSpectrogramContext() {
  const context = useContext(SpectrogramContext);
  if (context === undefined || context === null) {
    throw new Error('useSpectrogramContext must be used within a SpectrogramContextProvider');
  }
  return context;
}
