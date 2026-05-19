import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { SlidersHorizontal, ChevronDown, X, ArrowDownAZ, ArrowUp } from 'lucide-react';
import { FacetPopover } from './FacetPopover';
import {
  FilterState,
  ARTIST_FACETS,
  ALBUM_FACETS,
} from '../../utils/filterState';
import { useFilterActions } from '../../hooks/useFilterActions';
import type { SortOption } from '../../store/index';

interface FilterBarProps {
  view: 'artists' | 'albums';
  filterState: FilterState;
  onFilterChange: (state: FilterState) => void;
  onOpenQueryBuilder: () => void;
  facetValues: { value: string; count: number }[][];
  isMobile?: boolean;
}

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'recentlyAdded', label: 'Recently added' },
  { value: 'year', label: 'Year' },
];

export const FilterBar: React.FC<FilterBarProps> = ({
  view,
  filterState,
  onFilterChange,
  onOpenQueryBuilder,
  facetValues,
  isMobile,
}) => {
  const [openFacet, setOpenFacet] = useState<string | null>(null);
  const facetRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [sortOpen, setSortOpen] = useState(false);
  const sortRef = useRef<HTMLButtonElement>(null);
  const [tooltip, setTooltip] = useState<{ key: string; label: string; sub?: string; rect: DOMRect } | null>(null);

  const facets = view === 'artists' ? ARTIST_FACETS : ALBUM_FACETS;

  const {
    handleFacetToggle,
    handleSortChange: _handleSortChange,
    handleToggleSortDirection,
    handleRemoveChip,
    handleClearAll,
    totalActiveChips,
    hasFilters,
    queryActive,
    activeChips,
  } = useFilterActions(filterState, onFilterChange);

  const handleSortChange = (sort: SortOption) => {
    _handleSortChange(sort);
    setSortOpen(false);
  };

  const showTip = (key: string, label: string, sub: string | undefined, el: HTMLElement | null) => {
    if (!el) return;
    if (openFacet || sortOpen) return; // suppress tooltip when a popover is open
    setTooltip({ key, label, sub, rect: el.getBoundingClientRect() });
  };
  const hideTip = (key: string) => {
    setTooltip(t => (t && t.key === key ? null : t));
  };

  if (isMobile) {
    const isActive = totalActiveChips > 0 || queryActive;
    return (
      <div className="filter-zone filter-zone--mobile">
        <button
          onClick={onOpenQueryBuilder}
          className={`filter-icon-btn ${isActive ? 'filter-icon-btn--active' : ''} min-h-[44px] min-w-[44px]`}
          style={{ width: 44, height: 44, borderRadius: 14 }}
          aria-label={isActive ? `Filters (${totalActiveChips} active)` : 'Filters'}
        >
          <SlidersHorizontal size={18} strokeWidth={1.75} />
        </button>
      </div>
    );
  }

  const currentSort = SORT_OPTIONS.find(o => o.value === filterState.sort);

  return (
    <div className="filter-zone">
      <div className="filter-rack" role="toolbar" aria-label={`Filter ${view}`}>
        {facets.map((facet, idx) => {
          const values = facetValues[idx] || [];
          const selected = filterState.facets[facet.key] || [];
          const isActive = selected.length > 0;
          const isOpen = openFacet === facet.key;

          return (
            <div key={facet.key} className="relative">
              <button
                ref={el => { facetRefs.current[facet.key] = el; }}
                onClick={() => { setOpenFacet(isOpen ? null : facet.key); setTooltip(null); }}
                onMouseEnter={e => showTip(facet.key, facet.label, isActive ? `${selected.length} selected` : undefined, e.currentTarget)}
                onMouseLeave={() => hideTip(facet.key)}
                onFocus={e => showTip(facet.key, facet.label, isActive ? `${selected.length} selected` : undefined, e.currentTarget)}
                onBlur={() => hideTip(facet.key)}
                className={`filter-icon-btn ${isActive ? 'filter-icon-btn--active' : ''}`}
                aria-expanded={isOpen}
                aria-haspopup="listbox"
                aria-label={`${facet.label}${isActive ? `, ${selected.length} selected` : ''}`}
              >
                <facet.icon size={16} strokeWidth={1.75} />
                <span className="filter-icon-btn__label">{facet.label}</span>
                {isActive && (
                  <span key={selected.length} className="filter-icon-btn__pulse" aria-hidden />
                )}
              </button>
              {isOpen && (
                <FacetPopover
                  anchorRef={{ current: facetRefs.current[facet.key] || null }}
                  values={values}
                  selected={selected}
                  onToggle={(v) => handleFacetToggle(facet.key, v)}
                  onClose={() => setOpenFacet(null)}
                  facetLabel={facet.label}
                />
              )}
            </div>
          );
        })}

        <div className="filter-rack__breath" aria-hidden />

        <button
          onClick={handleToggleSortDirection}
          onMouseEnter={e => showTip('direction', filterState.sortDirection === 'asc' ? 'ascending' : 'descending', undefined, e.currentTarget)}
          onMouseLeave={() => hideTip('direction')}
          onFocus={e => showTip('direction', filterState.sortDirection === 'asc' ? 'ascending' : 'descending', undefined, e.currentTarget)}
          onBlur={() => hideTip('direction')}
          className="filter-icon-btn"
          aria-label={`Sort direction: ${filterState.sortDirection === 'asc' ? 'ascending' : 'descending'}, click to flip`}
        >
          <span
            className={`filter-direction-arrow ${filterState.sortDirection === 'desc' ? 'filter-direction-arrow--desc' : ''}`}
          >
            <ArrowUp size={15} strokeWidth={1.75} />
          </span>
          <span className="filter-icon-btn__label">
            {filterState.sortDirection === 'asc' ? 'asc' : 'desc'}
          </span>
        </button>

        <div className="relative">
          <button
            ref={sortRef}
            onClick={() => { setSortOpen(!sortOpen); setTooltip(null); }}
            onMouseEnter={e => showTip('sort', 'Sort by', currentSort?.label, e.currentTarget)}
            onMouseLeave={() => hideTip('sort')}
            onFocus={e => showTip('sort', 'Sort by', currentSort?.label, e.currentTarget)}
            onBlur={() => hideTip('sort')}
            className="filter-sort-btn"
            aria-expanded={sortOpen}
            aria-haspopup="listbox"
            aria-label={`Sort by ${currentSort?.label}`}
          >
            <ArrowDownAZ size={15} strokeWidth={1.75} />
            <span key={currentSort?.value} className="filter-sort-value">{currentSort?.label.toLowerCase()}</span>
            <ChevronDown
              size={11}
              strokeWidth={2}
              style={{ opacity: 0.6, transition: 'transform 200ms cubic-bezier(0.16, 1, 0.3, 1)', transform: sortOpen ? 'rotate(180deg)' : 'none' }}
            />
          </button>
          {sortOpen && (
            <SortDropdown
              anchorRef={sortRef}
              selected={filterState.sort}
              onSelect={handleSortChange}
              onClose={() => setSortOpen(false)}
            />
          )}
        </div>

        <button
          onClick={onOpenQueryBuilder}
          onMouseEnter={e => showTip('query', 'Advanced query', queryActive ? 'active' : undefined, e.currentTarget)}
          onMouseLeave={() => hideTip('query')}
          onFocus={e => showTip('query', 'Advanced query', queryActive ? 'active' : undefined, e.currentTarget)}
          onBlur={() => hideTip('query')}
          className={`filter-icon-btn ${queryActive ? 'filter-icon-btn--active' : ''}`}
          aria-label={queryActive ? 'Edit advanced query' : 'Build advanced query'}
          aria-pressed={queryActive}
        >
          <SlidersHorizontal size={16} strokeWidth={1.75} />
          <span className="filter-icon-btn__label">Query</span>
        </button>
      </div>

      {(activeChips.length > 0 || hasFilters) && (
        <div className="filter-strip" role="region" aria-label="Active filters">
          {activeChips.length > 0 && (
            <span className="filter-strip__lede">listening with</span>
          )}
          {activeChips.map(({ facetKey, value }, i) => (
            <span
              key={`${facetKey}-${value}`}
              className="filter-strip__item"
              style={{ ['--stagger' as any]: i }}
            >
              <span>{value}</span>
              <button
                onClick={() => handleRemoveChip(facetKey, value)}
                className="filter-strip__remove"
                aria-label={`Remove ${value} filter`}
                type="button"
              >
                <X size={11} strokeWidth={2.25} />
              </button>
            </span>
          ))}
          {hasFilters && (
            <button
              onClick={handleClearAll}
              className="filter-strip__clear"
              type="button"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {tooltip && <FilterTip key={tooltip.key} label={tooltip.label} sub={tooltip.sub} rect={tooltip.rect} />}
    </div>
  );
};

const FilterTip: React.FC<{ label: string; sub?: string; rect: DOMRect }> = ({ label, sub, rect }) => {
  const [pos, setPos] = useState<{ top: number; left: number; w: number }>({ top: 0, left: 0, w: 0 });
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const tipW = ref.current.offsetWidth;
    const top = rect.bottom + 8;
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - tipW / 2, window.innerWidth - tipW - 8));
    setPos({ top, left, w: tipW });
  }, [rect]);

  return createPortal(
    <div ref={ref} className="filter-tip" style={{ top: pos.top, left: pos.left }} role="tooltip">
      <span>{label}</span>
      {sub && <span className="filter-tip__sub">{sub}</span>}
    </div>,
    document.body
  );
};

const SortDropdown: React.FC<{
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  selected: SortOption;
  onSelect: (s: SortOption) => void;
  onClose: () => void;
}> = ({ anchorRef, selected, onSelect, onClose }) => {
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) && anchorRef.current && !anchorRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, anchorRef]);

  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
  }, [anchorRef]);

  useEffect(() => {
    const recalculate = () => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({ top: rect.bottom + 8, right: window.innerWidth - rect.right });
    };
    window.addEventListener('scroll', recalculate, true);
    window.addEventListener('resize', recalculate);
    return () => {
      window.removeEventListener('scroll', recalculate, true);
      window.removeEventListener('resize', recalculate);
    };
  }, [anchorRef]);

  if (!pos) return null;

  return createPortal(
    <div
      ref={dropdownRef}
      role="listbox"
      aria-label="Sort by"
      className="facet-popover fixed z-[9000] w-48 py-1.5 rounded-xl bg-[var(--color-background)] border border-[var(--glass-border)] shadow-2xl backdrop-blur-xl overflow-hidden"
      style={{ top: pos.top, right: pos.right, transformOrigin: 'top right' }}
    >
      {SORT_OPTIONS.map(opt => (
        <button
          key={opt.value}
          role="option"
          aria-selected={opt.value === selected}
          onClick={() => onSelect(opt.value)}
          className={`w-full text-left px-4 py-2 text-sm transition-colors flex items-center justify-between ${
            opt.value === selected
              ? 'text-[var(--color-primary)]'
              : 'text-[var(--color-text-primary)] hover:bg-[var(--color-surface-variant)]'
          }`}
        >
          <span style={{ fontFamily: 'Syne, system-ui, sans-serif', fontStyle: opt.value === selected ? 'italic' : 'normal' }}>
            {opt.label.toLowerCase()}
          </span>
          {opt.value === selected && (
            <span
              aria-hidden
              style={{
                width: 6,
                height: 6,
                borderRadius: 999,
                background: 'var(--color-primary)',
                boxShadow: '0 0 8px rgba(34, 201, 131, 0.6)',
              }}
            />
          )}
        </button>
      ))}
    </div>,
    document.body
  );
};
