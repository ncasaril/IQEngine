// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

import React, { useState, useEffect } from 'react';
import { Layer, Rect, Text } from 'react-konva';
import { unitPrefixSamples, unitPrefixSeconds } from '@/utils/rf-functions';
import { useCursorContext } from '../hooks/use-cursor-context';
import { useSpectrogramContext } from '../hooks/use-spectrogram-context';

interface TimeSelectorProps {
  currentFFT: number;
}

const TimeSelector = ({ currentFFT }: TimeSelectorProps) => {
  const [diffSamples, setDiffSamples] = useState('');
  const [diffSeconds, setDiffSeconds] = useState('');
  const { spectrogramWidth, spectrogramHeight, meta, fftSize, fftStepSize } = useSpectrogramContext();
  const { cursorTime, cursorTimeEnabled, setCursorTime } = useCursorContext();

  // Under Zoom Out Level > 0 each viewport pixel aggregates (fftStepSize + 1) source
  // FFT rows. The sample math below must scale by this factor in both directions so
  // a visually-sizable drag yields a time span that matches how much of the recording
  // the selection actually covers.
  const rowsPerPixel = fftStepSize + 1;
  const cursorStartFFT = Math.floor(cursorTime.start / fftSize);
  const cursorEndFFT = Math.floor(cursorTime.end / fftSize);
  const cursorYStart = (cursorStartFFT - currentFFT) / rowsPerPixel;
  const cursorYEnd = (cursorEndFFT - currentFFT) / rowsPerPixel;

  // update diff
  useEffect(() => {
    if (!cursorTimeEnabled || !meta) return;
    const diffSeconds = (cursorTime.end - cursorTime.start) / meta.getSampleRate();
    const formatted = unitPrefixSamples(cursorTime.end - cursorTime.start);
    setDiffSamples('Δ ' + formatted.samples + formatted.unit + ' samples');
    const formattedSeconds = unitPrefixSeconds(diffSeconds);
    setDiffSeconds('Δ ' + formattedSeconds.time + ' ' + formattedSeconds.unit);
  }, [cursorTime, cursorTimeEnabled]);

  const sampleAtPixelY = (pixelY: number) =>
    Math.max(currentFFT * fftSize, (currentFFT + pixelY * rowsPerPixel) * fftSize);

  // Sample-start bar
  const handleDragMoveStart = (e) => {
    e.target.x(0); // keep line in the same x location
    const newStartSample = sampleAtPixelY(e.target.y());
    // check if there is the need to reverse the two
    if (newStartSample > cursorTime.end) {
      setCursorTime({
        start: cursorTime.end,
        end: newStartSample,
      });
    } else {
      setCursorTime({
        start: newStartSample,
        end: cursorTime.end,
      });
    }
  };

  // Sample-end bar
  const handleDragMoveEnd = (e) => {
    e.target.x(0); // keep line in the same x location
    const newStartSample = sampleAtPixelY(e.target.y());
    if (newStartSample > cursorTime.start) {
      setCursorTime({
        start: cursorTime.start,
        end: newStartSample,
      });
    } else {
      setCursorTime({
        start: newStartSample,
        end: cursorTime.start,
      });
    }
  };

  // add cursor styling
  function onMouseOver() {
    document.body.style.cursor = 'move';
  }
  function onMouseOut() {
    document.body.style.cursor = 'default';
  }

  if (!cursorTimeEnabled) return null;

  return (
    <>
      <Layer>
        <>
          <Rect
            x={0}
            y={cursorYStart}
            width={spectrogramWidth}
            height={cursorYEnd - cursorYStart}
            fill="black"
            opacity={0.4}
            listening={false}
          />

          <Rect
            x={0}
            y={cursorYStart}
            width={spectrogramWidth}
            height={0}
            draggable={true}
            onDragMove={handleDragMoveStart}
            onMouseOver={onMouseOver}
            onMouseOut={onMouseOut}
            strokeEnabled={true}
            strokeWidth={5}
            stroke="red"
            opacity={0.75}
            shadowColor="red"
            shadowOffsetY={-3}
            shadowBlur={5}
          ></Rect>

          <Rect
            x={0}
            y={cursorYEnd}
            width={spectrogramWidth}
            height={0}
            draggable={true}
            onDragMove={handleDragMoveEnd}
            onMouseOver={onMouseOver}
            onMouseOut={onMouseOut}
            strokeEnabled={true}
            strokeWidth={5}
            stroke="red"
            opacity={0.75}
            shadowColor="red"
            shadowOffsetY={3}
            shadowBlur={5}
          />

          <Text text={diffSamples} fontFamily="serif" fontSize={24} x={0} y={cursorYStart + 5} fill={'white'} />

          <Text text={diffSeconds} fontFamily="serif" fontSize={24} x={0} y={cursorYStart + 35} fill={'white'} />
        </>
      </Layer>
    </>
  );
};

export default TimeSelector;
