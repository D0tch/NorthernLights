import React from 'react';
import { AudioWaveform } from 'lucide-react';
import { usePlayerStore } from '../store/index';
import { UserMenu } from './UserMenu';
import { GlobalSearchSlot } from './GlobalSearchSlot';

interface HeaderProps {
  onOpenSettings: () => void;
  isScannerVisible: boolean;
  onToggleScanner: () => void;
}

// Mobile top bar. Memoized + reads its own store slices so it doesn't re-render
// when App re-renders (App no longer re-renders on navigation, but this keeps it
// isolated from App's other state changes too). No location dependency.
const MobileHeaderInner: React.FC<HeaderProps> = ({ onOpenSettings, isScannerVisible, onToggleScanner }) => {
  const isAdmin = usePlayerStore(s => s.currentUser?.role === 'admin');
  const isScanningGlobal = usePlayerStore(s => s.isScanning);

  return (
    <div className="md:hidden px-4 pt-[max(0.75rem,var(--safe-area-top))] pb-3 flex items-center justify-between border-b border-[var(--glass-border)] bg-[var(--glass-bg)] backdrop-blur-md">
      <AudioWaveform size={22} className="text-[var(--color-primary)]" />
      <div className="flex items-center gap-1">
        {isAdmin && isScanningGlobal && (
          <button
            onClick={onToggleScanner}
            className="scan-indicator-btn scan-indicator-btn--dot-only"
            title={isScannerVisible ? 'Hide scan progress' : 'Show scan progress'}
          >
            <div className="scan-indicator-dot" />
          </button>
        )}
        <GlobalSearchSlot />
        <UserMenu onOpenSettings={onOpenSettings} />
      </div>
    </div>
  );
};

export const MobileHeader = React.memo(MobileHeaderInner);
export default MobileHeader;
