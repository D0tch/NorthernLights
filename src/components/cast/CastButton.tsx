import React, { useEffect, useMemo, useState } from 'react';
import { Cast } from 'lucide-react';
import { castManager } from '../../utils/CastManager';

type CastButtonSize = 'sm' | 'md' | 'lg';

interface CastButtonProps {
  className?: string;
  labelClassName?: string;
  showDeviceName?: boolean;
  showIntro?: boolean;
  showStopAction?: boolean;
  size?: CastButtonSize;
}

const INTRO_STORAGE_KEY = 'aurora-cast-intro-dismissed-v1';

const getInitialCastAvailable = () => Boolean((window as any).cast?.framework);

export const CastButton: React.FC<CastButtonProps> = ({
  className = '',
  labelClassName = '',
  showDeviceName = false,
  showIntro = false,
  showStopAction = false,
  size = 'md',
}) => {
  const [castApiAvailable, setCastApiAvailable] = useState(getInitialCastAvailable);
  const [castState, setCastState] = useState(castManager.getCastState());
  const [deviceName, setDeviceName] = useState(castManager.getCastDeviceName());
  const [introDismissed, setIntroDismissed] = useState(() => {
    try {
      return localStorage.getItem(INTRO_STORAGE_KEY) === 'true';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    const handleCastReady = () => {
      setCastApiAvailable(true);
      setCastState(castManager.getCastState());
      setDeviceName(castManager.getCastDeviceName());
    };

    if (getInitialCastAvailable()) {
      handleCastReady();
    } else {
      window.addEventListener('castApiAvailable', handleCastReady);
    }

    const unsubscribe = castManager.addStateChangeListener((nextState) => {
      setCastApiAvailable(getInitialCastAvailable());
      setCastState(nextState);
      setDeviceName(nextState === 'CONNECTED' ? castManager.getCastDeviceName() : '');
    });

    return () => {
      window.removeEventListener('castApiAvailable', handleCastReady);
      unsubscribe();
    };
  }, []);

  const isConnected = castState === 'CONNECTED';
  const isConnecting = castState === 'CONNECTING';
  const hasDevices = castState !== 'NO_DEVICES_AVAILABLE';
  const isVisible = castApiAvailable && hasDevices;

  useEffect(() => {
    castManager.logCastButtonState(
      `visible=${isVisible} api=${castApiAvailable} state=${castState} device=${deviceName || 'none'} size=${size}`
    );
  }, [castApiAvailable, castState, deviceName, isVisible, size]);

  const ariaLabel = useMemo(() => {
    if (isConnected && deviceName) return `Cast connected to ${deviceName}. Open Cast dialog`;
    if (isConnected) return 'Cast connected. Open Cast dialog';
    if (isConnecting) return 'Connecting to Cast device';
    return 'Cast to device';
  }, [deviceName, isConnected, isConnecting]);

  const dismissIntro = () => {
    setIntroDismissed(true);
    try {
      localStorage.setItem(INTRO_STORAGE_KEY, 'true');
    } catch {
      // Ignore storage failures. The coach mark is non-critical.
    }
  };

  const openController = () => {
    window.dispatchEvent(new Event('aurora:open-cast-controller'));
  };

  if (!isVisible) return null;

  return (
    <div
      className={`aurora-cast-control aurora-cast-control-${size} ${className}`}
      data-cast-state={castState}
    >
      <span className="aurora-cast-button-shell">
        <Cast className="aurora-cast-icon" aria-hidden="true" strokeWidth={1.8} />
        {React.createElement('google-cast-launcher', {
          class: 'aurora-cast-launcher',
          className: 'aurora-cast-launcher',
          'aria-label': ariaLabel,
          title: ariaLabel,
        })}
      </span>

      {showDeviceName && isConnected && deviceName && (
        <button
          type="button"
          className={`aurora-cast-device ${labelClassName}`}
          title={`Open Cast controller for ${deviceName}`}
          onClick={openController}
        >
          {deviceName}
        </button>
      )}

      {showStopAction && isConnected && (
        <button
          type="button"
          className="aurora-cast-stop"
          onClick={() => castManager.disconnect()}
        >
          Stop
        </button>
      )}

      {showIntro && !introDismissed && !isConnected && (
        <div className="aurora-cast-intro" role="status">
          <div className="aurora-cast-intro-title">Cast is ready</div>
          <div className="aurora-cast-intro-copy">Send playback to nearby speakers or TVs.</div>
          <button type="button" onClick={dismissIntro} className="aurora-cast-intro-action">
            Got it
          </button>
        </div>
      )}
    </div>
  );
};

export default CastButton;
