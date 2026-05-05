import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Wifi } from 'lucide-react';
import { castManager, type CastHealthStatus } from '../../utils/CastManager';

const TRANSIENT_PHASES = new Set<CastHealthStatus['phase']>(['recovered', 'warning']);

const iconForPhase = (phase: CastHealthStatus['phase']) => {
  if (phase === 'recovering' || phase === 'rejoining') return <Loader2 size={15} className="animate-spin" />;
  if (phase === 'recovered') return <CheckCircle2 size={15} />;
  if (phase === 'error' || phase === 'warning') return <AlertCircle size={15} />;
  return <Wifi size={15} />;
};

export const CastStatusBanner: React.FC = () => {
  const [status, setStatus] = useState<CastHealthStatus>(castManager.getHealthStatus());
  const [visible, setVisible] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);

  useEffect(() => castManager.addHealthChangeListener((nextStatus) => {
    setStatus(nextStatus);
    setVisible(Boolean(nextStatus.message) && nextStatus.phase !== 'connected' && nextStatus.phase !== 'idle');
  }), []);

  useEffect(() => {
    if (!visible || !TRANSIENT_PHASES.has(status.phase)) return;
    const timer = window.setTimeout(() => setVisible(false), 5200);
    return () => window.clearTimeout(timer);
  }, [status.phase, status.updatedAt, visible]);

  if (!visible) return null;

  const canRetry = status.phase === 'error' || status.phase === 'warning';
  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await castManager.retryConnectionFromUi();
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div className="cast-status-banner" data-cast-health={status.phase} role="status" aria-live="polite">
      <span className="cast-status-icon" aria-hidden="true">
        {iconForPhase(status.phase)}
      </span>
      <span className="cast-status-copy">
        {status.message}
      </span>
      {canRetry && (
        <button
          type="button"
          className="cast-status-action"
          onClick={handleRetry}
          disabled={isRetrying}
        >
          {isRetrying ? 'Retrying' : 'Retry'}
        </button>
      )}
    </div>
  );
};

export default CastStatusBanner;
