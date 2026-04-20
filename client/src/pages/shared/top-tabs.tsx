import React from 'react';
import { Link, useNavigate } from 'react-router-dom';

export const LAST_RECORDING_STORAGE_KEY = 'iqengine:lastRecordingPath';

export type RecordingTab = 'Spectrogram' | 'Time' | 'Demod' | 'Frequency' | 'IQ' | 'Cyclostationary';
export type ShellTab = 'Live' | RecordingTab;

interface Props {
  // "Live" when on /sdr/live, or the name of the currently selected recording tab.
  activeTab: ShellTab;
  // When rendered inside recording-view, onSelectRecordingTab switches state locally
  // (no navigation). On /sdr/live, these links navigate to the last recording.
  onSelectRecordingTab?: (tab: RecordingTab) => void;
  // Path to the currently-loaded recording view (e.g. "/view/api/local/local/sdr_captures%2F...").
  // When provided and non-null, recording tabs render as state-toggling buttons; when null,
  // they render as Links to the stored last-recording path (or are disabled if none).
  currentRecordingPath?: string | null;
}

const RECORDING_TABS: RecordingTab[] = ['Spectrogram', 'Time', 'Demod', 'Frequency', 'IQ', 'Cyclostationary'];

export function TopTabs({ activeTab, onSelectRecordingTab, currentRecordingPath }: Props) {
  const navigate = useNavigate();
  const lastRecordingPath = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_RECORDING_STORAGE_KEY) : null;

  const baseClass =
    'inline-block px-3 py-0 outline outline-primary outline-1 text-lg text-primary hover:text-accent hover:shadow-lg hover:shadow-accent cursor-pointer select-none';
  const activeClass = 'bg-primary !text-base-100';
  const disabledClass = 'opacity-40 cursor-not-allowed hover:text-primary';

  const liveActive = activeTab === 'Live';

  return (
    <div className="flex space-x-2 border-b border-primary w-full sm:pl-12 lg:pl-32" id="tabsbar">
      {liveActive ? (
        <div className={`${baseClass} ${activeClass}`}>Live</div>
      ) : (
        <Link to="/sdr/live" className={baseClass}>
          Live
        </Link>
      )}
      {RECORDING_TABS.map((tab) => {
        const isActive = activeTab === tab;
        const canLocalToggle = !!currentRecordingPath && !!onSelectRecordingTab;
        if (canLocalToggle) {
          return (
            <div
              key={tab}
              onClick={() => onSelectRecordingTab!(tab)}
              className={`${baseClass} ${isActive ? activeClass : ''}`}
            >
              {tab}
            </div>
          );
        }
        if (lastRecordingPath) {
          return (
            <div
              key={tab}
              onClick={() => navigate(`${lastRecordingPath}?tab=${tab}`)}
              className={baseClass}
            >
              {tab}
            </div>
          );
        }
        return (
          <div key={tab} className={`${baseClass} ${disabledClass}`} title="Open a recording first">
            {tab}
          </div>
        );
      })}
    </div>
  );
}
