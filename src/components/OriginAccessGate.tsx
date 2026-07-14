import React from 'react';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';

const ORIGIN_PROBE_TIMEOUT_MS = 3_000;

interface OriginStatusResponse {
  allowed: boolean;
  origin: string;
}

interface OriginAccessGateProps {
  children: React.ReactNode;
}

async function fetchOriginStatus(): Promise<OriginStatusResponse | null> {
  const browserOrigin = window.location.origin;
  const response = await fetchWithTimeout(`/api/origin-status?origin=${encodeURIComponent(browserOrigin)}`, {
    cache: 'no-store',
    credentials: 'same-origin',
  }, ORIGIN_PROBE_TIMEOUT_MS);
  const data: unknown = await response.json().catch(() => null);

  if (
    !data ||
    typeof data !== 'object' ||
    typeof (data as Partial<OriginStatusResponse>).allowed !== 'boolean' ||
    typeof (data as Partial<OriginStatusResponse>).origin !== 'string'
  ) {
    return null;
  }

  return data as OriginStatusResponse;
}

const OriginCheckLoading: React.FC = () => (
  <main className="origin-access" aria-busy="true" aria-live="polite">
    <div className="origin-access__loading" role="status">
      <Loader2 className="origin-access__spinner" aria-hidden="true" />
      <span>Checking server access…</span>
    </div>
  </main>
);

const BlockedOriginScreen: React.FC<{
  origin: string;
  isRetrying: boolean;
  onRetry: () => void;
}> = ({ origin, isRetrying, onRetry }) => (
  <main className="origin-access">
    <section className="origin-access__panel" role="alert" aria-labelledby="blocked-origin-title">
      <div className="origin-access__icon" aria-hidden="true">
        <ShieldAlert />
      </div>
      <p className="origin-access__eyebrow">Configuration required</p>
      <h1 id="blocked-origin-title">This address is not allowed</h1>
      <p>Aurora is not configured to accept browser requests from this origin.</p>
      <div className="origin-access__origin">
        <span>Current origin</span>
        <code>{origin}</code>
      </div>
      <p className="origin-access__instruction">
        Add this exact origin to <code>ALLOWED_ORIGINS</code> in <code>.env</code>, restart Aurora, then try again.
      </p>
      <button
        type="button"
        className="btn btn-primary btn-lg"
        disabled={isRetrying}
        onClick={onRetry}
      >
        <RefreshCw className={isRetrying ? 'origin-access__spinner' : ''} aria-hidden="true" />
        {isRetrying ? 'Checking…' : 'Try again'}
      </button>
    </section>
  </main>
);

export const OriginAccessGate: React.FC<OriginAccessGateProps> = ({ children }) => {
  const [status, setStatus] = React.useState<OriginStatusResponse | null>(null);
  const [isChecking, setIsChecking] = React.useState(true);
  const checkSequence = React.useRef(0);

  const checkAccess = React.useCallback(async () => {
    const sequence = ++checkSequence.current;
    setIsChecking(true);

    try {
      const result = await fetchOriginStatus();
      if (sequence !== checkSequence.current) return;

      // Fail open for older servers and genuine network outages. Existing health
      // and offline handling remains responsible for those cases.
      setStatus((current) => result || current || { allowed: true, origin: window.location.origin });
    } catch {
      if (sequence !== checkSequence.current) return;
      setStatus((current) => current || { allowed: true, origin: window.location.origin });
    } finally {
      if (sequence === checkSequence.current) setIsChecking(false);
    }
  }, []);

  const continueOffline = React.useCallback(() => {
    checkSequence.current += 1;
    setStatus((current) => current && !current.allowed
      ? current
      : { allowed: true, origin: window.location.origin });
    setIsChecking(false);
  }, []);

  React.useEffect(() => {
    const handleOnline = () => void checkAccess();
    const handleOffline = () => continueOffline();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if (navigator.onLine) {
      void checkAccess();
    } else {
      continueOffline();
    }

    return () => {
      checkSequence.current += 1;
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [checkAccess, continueOffline]);

  if (!status) return <OriginCheckLoading />;
  if (!status.allowed) {
    return <BlockedOriginScreen origin={status.origin} isRetrying={isChecking} onRetry={() => void checkAccess()} />;
  }

  return <>{children}</>;
};
