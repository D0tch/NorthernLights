import { useEffect, useRef } from 'react';
import { useToast } from '../../hooks/useToast';
import { castManager, type CastHealthStatus } from '../../utils/CastManager';

const TOAST_PHASES = new Set<CastHealthStatus['phase']>(['recovered', 'warning', 'error']);

const toastTypeForPhase = (phase: CastHealthStatus['phase']) => {
  if (phase === 'recovered') return 'success';
  if (phase === 'error') return 'error';
  return 'info';
};

export const CastHealthToasts: React.FC = () => {
  const { addToast } = useToast();
  const lastToastKeyRef = useRef('');

  useEffect(() => castManager.addHealthChangeListener((status) => {
    if (!status.message || !TOAST_PHASES.has(status.phase)) {
      lastToastKeyRef.current = '';
      return;
    }

    const toastKey = `${status.phase}:${status.message}:${status.detail || ''}`;
    if (toastKey === lastToastKeyRef.current) return;
    lastToastKeyRef.current = toastKey;

    const canRetry = status.phase === 'warning' || status.phase === 'error';
    addToast(status.message, toastTypeForPhase(status.phase), {
      duration: canRetry ? 8000 : 3600,
      actionLabel: canRetry ? 'Retry' : undefined,
      onAction: canRetry ? () => { void castManager.retryConnectionFromUi(); } : undefined,
    });
  }), [addToast]);

  return null;
};

export default CastHealthToasts;
