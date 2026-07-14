/// <reference types="vite-plugin-pwa/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import './utils/pwaInstall';
import { registerSW } from 'virtual:pwa-register';
import { usePlayerStore } from './store';
import { setPwaUpdateHandler } from './utils/pwaUpdate';

// Auto-recover from stale lazy chunks. After a deploy the hashed route chunks
// change; a tab still running the old build that navigates to a not-yet-loaded
// route asks for a chunk the server no longer has → Vite fires `vite:preloadError`
// and React would otherwise show a blank screen until a manual F5. We reload once
// to pull the new build, guarding with sessionStorage so a genuinely missing
// asset can't trap us in a reload loop.
window.addEventListener('vite:preloadError', (event) => {
  const RELOAD_KEY = 'nl-chunk-reload-at';
  const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
  // Allow a fresh recovery reload at most once every 10s.
  if (Date.now() - last < 10000) return;
  event.preventDefault();
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  window.location.reload();
});

// Register the PWA service worker
const updateServiceWorker = registerSW({
  immediate: true,
  onNeedRefresh() {
    usePlayerStore.getState().setPendingUpdate(true);
  },
});
setPwaUpdateHandler(() => updateServiceWorker(true));

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('App crashed:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontFamily: 'sans-serif',
          color: '#ccc',
          background: '#1a1a2e',
          gap: '16px',
        }}>
          <h1 style={{ fontSize: '1.5rem', color: '#ff6b6b' }}>Something went wrong</h1>
          <pre style={{
            maxWidth: '600px',
            padding: '16px',
            background: '#16213e',
            borderRadius: '8px',
            fontSize: '0.85rem',
            overflow: 'auto',
            maxHeight: '200px',
          }}>
            {this.state.error?.message}
          </pre>
          <button
            className="btn btn-primary btn-lg"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>
  );
}
