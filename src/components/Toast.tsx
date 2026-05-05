import React, { useEffect, useState } from 'react';
import { CheckCircle, AlertCircle, Info, X } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

interface ToastProps {
  message: string;
  type: ToastType;
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}

const icons: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle size={18} />,
  error: <AlertCircle size={18} />,
  info: <Info size={18} />,
};

const colors: Record<ToastType, string> = {
  success: 'text-green-400 bg-green-500/10 border-green-500/20',
  error: 'text-red-400 bg-red-500/10 border-red-500/20',
  info: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
};

export const Toast: React.FC<ToastProps> = ({
  message,
  type,
  duration = 4000,
  actionLabel,
  onAction,
  onDismiss,
}) => {
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setExiting(true);
      setTimeout(onDismiss, 250);
    }, duration);
    return () => {
      clearTimeout(timer);
    };
  }, [duration, onDismiss]);

  const handleDismiss = () => {
    setExiting(true);
    setTimeout(onDismiss, 250);
  };

  const handleAction = () => {
    onAction?.();
    handleDismiss();
  };

  return (
    <div
      className={`flex items-center gap-3 px-5 py-3.5 rounded-2xl border shadow-2xl backdrop-blur-xl bg-[var(--glass-bg)] min-w-[280px] max-w-[420px] ${
        exiting ? 'animate-toast-exit' : 'animate-toast-enter'
      }`}
      role="status"
      aria-live="polite"
    >
      <span className={colors[type]}>{icons[type]}</span>
      <p className="flex-1 text-sm text-[var(--color-text-primary)]">{message}</p>
      {actionLabel && onAction && (
        <button
          onClick={handleAction}
          className="text-sm font-semibold text-[var(--color-primary)] hover:text-[var(--color-text-primary)] transition-colors shrink-0"
        >
          {actionLabel}
        </button>
      )}
      <button
        onClick={handleDismiss}
        className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors shrink-0"
      >
        <X size={16} />
      </button>
    </div>
  );
};
