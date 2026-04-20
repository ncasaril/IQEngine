import React, { useEffect, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router-dom';
import { TopTabs, LAST_RECORDING_STORAGE_KEY, RecordingTab } from '@/pages/shared/top-tabs';
import { useSpectrogram } from './hooks/use-spectrogram';
import { Layer, Stage, Image } from 'react-konva';
import { useGetImage } from './hooks/use-get-image';
import { useServerSpectrogram } from './hooks/use-server-spectrogram';
import { KonvaEventObject } from 'konva/lib/Node';
import { RulerTop } from './components/ruler-top';
import { RulerSide } from './components/ruler-side';
import { SpectrogramContextProvider, useSpectrogramContext } from './hooks/use-spectrogram-context';
import { CursorContextProvider } from './hooks/use-cursor-context';
import { useMeta } from '@/api/metadata/queries';
import { IQPlot } from './components/iq-plot';
import { CyclostationaryPlot } from './components/cyclostationary-plot';
import { FrequencyPlot } from './components/frequency-plot';
import { TimePlot } from './components/time-plot';
import { Sidebar } from './components/sidebar';
import GlobalProperties from './components/global-properties';
import MetaViewer from './components/meta-viewer';
import MetaRaw from './components/meta-raw';
import AnnotationList from './components/annotation/annotation-list';
import ScrollBar from './components/scroll-bar';
import { MINIMAP_FFT_SIZE, MIN_SPECTROGRAM_HEIGHT } from '@/utils/constants';
import FreqSelector from './components/freq-selector';
import FreqShiftSelector from './components/freqshift-selector';
import TimeSelector from './components/time-selector';
import { AnnotationViewer } from './components/annotation/annotation-viewer';
import TimeSelectorMinimap from './components/time-selector-minimap';
import { useWindowSize } from 'usehooks-ts';

export function DisplaySpectrogram({ currentFFT, setCurrentFFT, currentTab }) {
  const {
    spectrogramWidth,
    magnitudeMin,
    magnitudeMax,
    colmap,
    windowFunction,
    fftSize,
    fftStepSize,
    timeZoomIn,
    meta,
    setSpectrogramWidth,
    setSpectrogramHeight,
    serverSideFFT,
  } = useSpectrogramContext();

  const { displayedIQ, spectrogramHeight } = useSpectrogram(currentFFT);
  const { width, height } = useWindowSize();

  // Server-side tile rendering (parallel path)
  const { image: serverImage, loading: serverLoading } = useServerSpectrogram(currentFFT);

  useEffect(() => {
    const spectrogramHeight = height - 450; // hand-tuned for now
    //console.log('spectrogramHeight: ', spectrogramHeight);
    setSpectrogramHeight(Math.max(MIN_SPECTROGRAM_HEIGHT, spectrogramHeight));
    const newSpectrogramWidth = width - 430; // hand-tuned for now
    setSpectrogramWidth(newSpectrogramWidth);
  }, [width, height]);

  const { image: clientImage, setIQData } = useGetImage(
    fftSize,
    spectrogramHeight,
    magnitudeMin,
    magnitudeMax,
    colmap,
    windowFunction
  );

  // Use server image when server-side FFT is enabled, otherwise use client-side
  const image = serverSideFFT ? serverImage : clientImage;

  function handleWheel(evt: KonvaEventObject<WheelEvent>): void {
    evt.evt.preventDefault();
    const rowsPerPixel = (fftStepSize + 1) / Math.max(1, timeZoomIn);
    // Scroll rate adjusts with zoom: one pixel of deltaY should move currentFFT by
    // the same number of source rows that pixel represents, so wheel feel stays
    // consistent between zoomed-in and zoomed-out views.
    const scrollAmount = Math.floor(evt.evt.deltaY * rowsPerPixel);
    const nextPosition = currentFFT + scrollAmount + spectrogramHeight * rowsPerPixel;
    const maxPosition = meta.getTotalSamples() / fftSize;

    if (nextPosition < maxPosition) {
      setCurrentFFT(Math.max(0, currentFFT + scrollAmount));
    }
  }

  // Sort of messy but this is how the IQ gets passed into useGetImage which internally has its own state for iqData
  useEffect(() => {
    if (displayedIQ && displayedIQ.length > 0) {
      setIQData(displayedIQ);
    }
  }, [displayedIQ]);

  return (
    <>
      {currentTab === Tab.Spectrogram && (
        <>
          <Stage width={spectrogramWidth + 110} height={30}>
            <RulerTop />
          </Stage>
          <div className="flex flex-row" id="spectrogram">
            <Stage width={spectrogramWidth} height={spectrogramHeight}>
              <Layer onWheel={handleWheel} imageSmoothingEnabled={false}>
                <Image image={image} x={0} y={0} width={spectrogramWidth} height={spectrogramHeight} />
              </Layer>
              <AnnotationViewer currentFFT={currentFFT} />
              <FreqSelector />
              <FreqShiftSelector />
              <TimeSelector currentFFT={currentFFT} />
            </Stage>
            <Stage width={50} height={spectrogramHeight} className="mr-1">
              <RulerSide currentRowAtTop={currentFFT} />
            </Stage>
            <Stage width={MINIMAP_FFT_SIZE + 5} height={spectrogramHeight}>
              <ScrollBar currentFFT={currentFFT} setCurrentFFT={setCurrentFFT} />
              <TimeSelectorMinimap />
            </Stage>
          </div>
        </>
      )}
      {currentTab === Tab.Time && <TimePlot displayedIQ={displayedIQ} fftStepSize={fftStepSize} />}
      {currentTab === Tab.Frequency && <FrequencyPlot displayedIQ={displayedIQ} fftStepSize={fftStepSize} />}
      {currentTab === Tab.IQ && <IQPlot displayedIQ={displayedIQ} fftStepSize={fftStepSize} />}
      {currentTab === Tab.Cyclostationary && (
        <CyclostationaryPlot displayedIQ={displayedIQ} fftStepSize={fftStepSize} />
      )}
    </>
  );
}

export function DisplayMetadataRaw() {
  const { meta } = useSpectrogramContext();
  return <MetaRaw meta={meta} />;
}

export function DisplayMetaSummary() {
  const { meta } = useSpectrogramContext();
  return <MetaViewer meta={meta} />;
}

enum Tab {
  Spectrogram,
  Time,
  Frequency,
  IQ,
  Cyclostationary,
}

export function RecordingViewPage() {
  const { type, account, container, filePath } = useParams();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { data: meta } = useMeta(type, account, container, filePath);
  const initialTabFromQuery = searchParams.get('tab') as RecordingTab | null;
  const [currentTab, setCurrentTab] = useState<Tab>(
    initialTabFromQuery && Tab[initialTabFromQuery] !== undefined ? Tab[initialTabFromQuery] : Tab.Spectrogram
  );
  const [currentFFT, setCurrentFFT] = useState<number>(0);

  // Remember the last recording so /sdr/live can navigate back here.
  useEffect(() => {
    const path = `${location.pathname}`;
    if (type && account && container && filePath) {
      window.localStorage.setItem(LAST_RECORDING_STORAGE_KEY, path);
    }
  }, [location.pathname, type, account, container, filePath]);

  if (!meta) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <div className="text-2xl font-bold">Loading...</div>
      </div>
    );
  }
  return (
    <SpectrogramContextProvider type={type} account={account} container={container} filePath={filePath}>
      <CursorContextProvider>
        <div className="mb-0 ml-0 mr-0 p-0 pt-3">
          <div className="flex flex-row w-full">
            <Sidebar currentFFT={currentFFT} />
            <div className="flex flex-col pl-3">
              <TopTabs
                activeTab={Tab[currentTab] as RecordingTab}
                currentRecordingPath={location.pathname}
                onSelectRecordingTab={(tab) => setCurrentTab(Tab[tab])}
              />
              {/* The following displays the spectrogram, time, freq, and IQ plots depending on which one is selected*/}
              <DisplaySpectrogram currentFFT={currentFFT} setCurrentFFT={setCurrentFFT} currentTab={currentTab} />
              <DisplayMetaSummary />
            </div>
          </div>
          <div className="mt-3 mb-0 px-2 py-0" style={{ margin: '5px' }}>
            <details>
              <summary className="pl-2 mt-2 bg-primary outline outline-1 outline-primary text-lg text-base-100 hover:bg-green-800">
                Annotations
              </summary>
              <div className="outline outline-1 outline-primary p-2">
                <AnnotationList setCurrentFFT={setCurrentFFT} currentFFT={currentFFT} />
              </div>
            </details>

            <details>
              <summary className="pl-2 mt-2 bg-primary outline outline-1 outline-primary text-lg text-base-100 hover:bg-green-800">
                Global Properties
              </summary>
              <div className="outline outline-1 outline-primary p-2">
                <GlobalProperties />
              </div>
            </details>
            <details>
              <summary className="pl-2 mt-2 bg-primary outline outline-1 outline-primary text-lg text-base-100 hover:bg-green-800">
                Raw Metadata
              </summary>
              <div className="outline outline-1 outline-primary p-2">
                <DisplayMetadataRaw />
              </div>
            </details>
          </div>
        </div>
      </CursorContextProvider>
    </SpectrogramContextProvider>
  );
}
