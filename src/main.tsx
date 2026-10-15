import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import ErrorBoundary from './ErrorBoundary.tsx';
import './index.css';

// Safe service worker registration with fallback for in-app browsers, restricted iframes, and private mode
try {
  if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
    registerSW({
      immediate: true,
      onRegisteredSW(_swUrl, r) {
        // Check for updates periodically
        if (r) {
          setInterval(() => {
            r.update().catch(() => {});
          }, 60 * 60 * 1000);
        }
      },
      onRegisterError(error) {
        console.warn('PWA registration skipped or failed:', error);
      },
    });
  }
} catch {
  // Gracefully continue without service worker
}

const rootElement = document.getElementById('root');
if (rootElement) {
  createRoot(rootElement).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
