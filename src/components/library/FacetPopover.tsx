import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Search, Check } from 'lucide-react';

interface FacetValue {
  value: string;
  count: number;
}

interface FacetPopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  values: FacetValue[];
  selected: string[];
  onToggle: (value: string) => void;
  onClose: () => void;
  facetLabel: string;
}

export const FacetPopover: React.FC<FacetPopoverProps> = ({
  anchorRef,
  values,
  selected,
  onToggle,
  onClose,
  facetLabel,
}) => {
  const [search, setSearch] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = search
    ? values.filter(v => v.value.toLowerCase().includes(search.toLowerCase()))
    : values;

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, anchorRef]);

  const handleToggle = useCallback((value: string) => {
    onToggle(value);
  }, [onToggle]);

  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const popW = 288;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const top = spaceBelow >= 320 || spaceBelow > spaceAbove
      ? rect.bottom + 6
      : Math.max(8, rect.top - 320);
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popW - 8));
    setPosition({ top, left });
  }, [anchorRef]);

  if (!position) return null;

  return createPortal(
    <div
      ref={popoverRef}
      role="listbox"
      aria-label={`Filter by ${facetLabel}`}
      className="facet-popover fixed z-[9000] w-72 max-h-80 flex flex-col rounded-xl bg-[var(--color-background)] border border-[var(--glass-border)] shadow-2xl backdrop-blur-xl overflow-hidden"
      style={{ top: position.top, left: position.left }}
    >
      <div
        className="px-3 pt-2.5 pb-1.5"
        style={{
          fontFamily: 'Syne, system-ui, sans-serif',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-text-muted)',
          opacity: 0.75,
        }}
      >
        {facetLabel}
      </div>
      {values.length > 5 && (
        <div className="px-2 pb-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Find in ${facetLabel.toLowerCase()}`}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-[var(--color-surface)] border border-[var(--glass-border)] text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/30"
              style={{ fontStyle: search ? 'normal' : 'italic' }}
            />
          </div>
        </div>
      )}
      <div className="overflow-y-auto flex-1 p-1" style={{ maxHeight: 280 }}>
        {filtered.length === 0 && (
          <div
            className="px-3 py-5 text-center"
            style={{
              fontFamily: 'Syne, system-ui, sans-serif',
              fontStyle: 'italic',
              fontSize: 13,
              color: 'var(--color-text-muted)',
            }}
          >
            nothing here
          </div>
        )}
        {filtered.map(v => {
          const isSelected = selected.includes(v.value);
          return (
            <button
              key={v.value}
              role="option"
              aria-selected={isSelected}
              onClick={() => handleToggle(v.value)}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-left text-sm transition-colors ${
                isSelected
                  ? 'text-[var(--color-primary)]'
                  : 'text-[var(--color-text-primary)] hover:bg-[var(--color-surface-variant)]'
              }`}
            >
              <span
                className={`w-4 h-4 rounded-md border flex items-center justify-center flex-shrink-0 transition-colors ${
                  isSelected
                    ? 'bg-[var(--color-primary)] border-[var(--color-primary)] text-white facet-popover__check--on'
                    : 'border-[var(--glass-border)]'
                }`}
              >
                {isSelected && <Check size={10} strokeWidth={3} />}
              </span>
              <span className="truncate flex-1" style={{ fontStyle: isSelected ? 'italic' : 'normal' }}>
                {v.value}
              </span>
              <span
                className="text-[10px] text-[var(--color-text-muted)] tabular-nums"
                style={{ opacity: 0.7, letterSpacing: '0.02em' }}
              >
                {v.count}
              </span>
            </button>
          );
        })}
      </div>
      {selected.length > 0 && (
        <div className="px-2 py-1.5 border-t border-[var(--glass-border)]">
          <button
            onClick={() => { selected.forEach(s => onToggle(s)); }}
            className="w-full py-1 transition-colors hover:text-[var(--aurora-pink)]"
            style={{
              fontFamily: 'Syne, system-ui, sans-serif',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--color-text-muted)',
            }}
          >
            Clear {selected.length}
          </button>
        </div>
      )}
    </div>,
    document.body
  );
};
