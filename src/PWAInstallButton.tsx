import React, { useState } from 'react';
import { usePWAInstall } from './usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        title="Install PWA"
        aria-label="Install App"
        className="h-[42px] sm:h-[40px] w-[42px] sm:w-[40px] flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] border border-zinc-800 text-zinc-300 hover:text-zinc-100 rounded-xl transition-all shrink-0 cursor-pointer select-none"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
          />
        </svg>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          title="Install on iOS"
          aria-label="Install on iOS"
          className="h-[42px] sm:h-[40px] w-[42px] sm:w-[40px] flex items-center justify-center bg-zinc-900 hover:bg-zinc-800 active:scale-[0.98] border border-zinc-800 text-zinc-300 hover:text-zinc-100 rounded-xl transition-all shrink-0 cursor-pointer select-none"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
            <div className="w-full max-w-sm rounded-2xl bg-zinc-900 border border-zinc-800 p-5 shadow-2xl text-zinc-100">
              <p className="text-sm text-zinc-300 leading-relaxed">
                1. Tap the <strong>Share</strong> button in Safari toolbar.
                <br />
                2. Scroll down and tap <strong>Add to Home Screen</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-4 w-full rounded-xl bg-zinc-800 hover:bg-zinc-700 py-2 text-sm font-medium text-zinc-100 transition cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};
