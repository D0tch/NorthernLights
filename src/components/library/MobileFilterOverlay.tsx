import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, SlidersHorizontal, ChevronDown, Check, ArrowUp } from 'lucide-react';
import {
  ARTIST_FACETS,
  ALBUM_FACETS,
  FilterState,
} from '../../utils/filterState';
import { useFilterActions } from '../../hooks/useFilterActions';
import type { SortOption } from '../../store/index';

interface MobileFilterOverlayProps {
  view: 'artists' | 'albums';
  isOpen: boolean;
  onClose: () => void;
  filterState: FilterState;
  onFilterChange: (state: FilterState) => void;
  onOpenQueryBuilder: () => void;
  facetValues: { value: string; count: number }[][];
}

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'recentlyAdded', label: 'Recently added' },
  { value: 'year', label: 'Year' },
];

export const MobileFilterOverlay: React.FC<MobileFilterOverlayProps> = ({
  view,
  isOpen,
  onClose,
  filterState,
  onFilterChange,
  onOpenQueryBuilder,
  facetValues,
}) => {
  const facets = view === 'artists' ? ARTIST_FACETS : ALBUM_FACETS;
  const [expandedFacet, setExpandedFacet] = useState<string | null>(null);

  const {
    handleFacetToggle,
    handleSortChange,
    handleToggleSortDirection,
    handleClearAll,
    totalActiveChips: totalActive,
    hasFilters,
  } = useFilterActions(filterState, onFilterChange);

  // Lock body scroll when overlay is open, compensating for scrollbar width
  // to prevent layout shift on desktop-width viewports.
  useEffect(() => {
    if (isOpen) {
      const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
      const prevOverflow = document.body.style.overflow;
      const prevPaddingRight = document.body.style.paddingRight;
      document.body.style.overflow = 'hidden';
      if (scrollbarWidth > 0) {
        document.body.style.paddingRight = `${scrollbarWidth}px`;
      }
      return () => {
        document.body.style.overflow = prevOverflow;
        document.body.style.paddingRight = prevPaddingRight;
      };
    }
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex flex-col" onClick={onClose}>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div
        className="relative z-10 flex flex-col h-full bg-[var(--color-background)] safe-area-bottom safe-area-top"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--glass-border)]">
          <h2 className="text-lg font-bold text-[var(--color-text-primary)]">
            Filters
          </h2>
          <button
            onClick={onClose}
            className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors p-2 rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
            aria-label="Close filters"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <section>
            <h3 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-2">
              Sort by
            </h3>
            <div className="flex gap-2 flex-wrap items-center">
              {SORT_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => handleSortChange(opt.value)}
                  className={`btn-tab ${filterState.sort === opt.value ? 'active' : ''}`}
                >
                  {opt.label}
                </button>
              ))}
              <button
                onClick={handleToggleSortDirection}
                className="filter-icon-btn"
                style={{ width: 40, height: 40 }}
                aria-label={`Sort direction: ${filterState.sortDirection === 'asc' ? 'ascending' : 'descending'}, tap to flip`}
                aria-pressed={filterState.sortDirection === 'desc'}
              >
                <span
                  className={`filter-direction-arrow ${filterState.sortDirection === 'desc' ? 'filter-direction-arrow--desc' : ''}`}
                >
                  <ArrowUp size={16} strokeWidth={1.75} />
                </span>
              </button>
            </div>
          </section>

          {facets.map((facet, idx) => {
            const values = facetValues[idx] || [];
            const selected = filterState.facets[facet.key] || [];
            const isExpanded = expandedFacet === facet.key;

            return (
              <section key={facet.key}>
                <button
                  onClick={() => setExpandedFacet(isExpanded ? null : facet.key)}
                  className="w-full flex items-center justify-between py-2"
                  aria-expanded={isExpanded}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
                    <facet.icon size={16} />
                    {facet.label}
                    {selected.length > 0 && (
                      <span className="w-5 h-5 rounded-full bg-[var(--color-primary)] text-white text-xs flex items-center justify-center tabular-nums">
                        {selected.length}
                      </span>
                    )}
                  </span>
                  <ChevronDown size={16} className={`text-[var(--color-text-muted)] transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`} />
                </button>
                {isExpanded && (
                  <div className="flex flex-wrap gap-2 pb-2">
                    {values.map(v => {
                      const isSelected = selected.includes(v.value);
                      return (
                        <button
                          key={v.value}
                          onClick={() => handleFacetToggle(facet.key, v.value)}
                          className={`flex items-center gap-1.5 px-3 py-2 rounded-full text-sm transition-colors border min-h-[40px] ${
                            isSelected
                              ? 'bg-[var(--color-primary)]/10 border-[var(--color-primary)]/30 text-[var(--color-primary)]'
                              : 'bg-[var(--glass-bg)] border-[var(--glass-border)] text-[var(--color-text-secondary)]'
                          }`}
                        >
                          {isSelected && <Check size={12} />}
                          <span>{v.value}</span>
                          <span className="text-xs text-[var(--color-text-muted)] tabular-nums">{v.count}</span>
                        </button>
                      );
                    })}
                    {values.length === 0 && (
                      <p className="text-sm text-[var(--color-text-muted)]">No data available</p>
                    )}
                  </div>
                )}
              </section>
            );
          })}

          <section>
            <button
              onClick={() => { onClose(); onOpenQueryBuilder(); }}
              className="btn btn-ghost w-full flex items-center justify-center gap-2"
            >
              <SlidersHorizontal size={16} />
              Build query
            </button>
          </section>
        </div>

        <div className="p-4 border-t border-[var(--glass-border)] flex gap-3">
          {hasFilters && (
            <button onClick={handleClearAll} className="btn btn-ghost flex-1">
              Clear filters
            </button>
          )}
          <button
            onClick={onClose}
            className="btn btn-primary flex-1"
          >
            {hasFilters ? `Apply (${totalActive})` : 'Done'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
