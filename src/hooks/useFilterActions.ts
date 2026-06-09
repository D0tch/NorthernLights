import { useCallback, useMemo } from 'react';
import {
  FilterState,
  EMPTY_FILTER_STATE,
  DEFAULT_SORT_DIRECTION,
  hasActiveFilters,
} from '../utils/filterState';
import type { SortOption } from '../store/index';

/**
 * Shared filter state mutation logic used by FilterBar (facet toggles,
 * sort, chip removal, clear-all). Keeps that logic out of the view layer.
 */
export function useFilterActions(
  filterState: FilterState,
  onFilterChange: (state: FilterState) => void,
) {
  const handleFacetToggle = useCallback((facetKey: string, value: string) => {
    const current = filterState.facets[facetKey] || [];
    const next = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    onFilterChange({
      ...filterState,
      facets: { ...filterState.facets, [facetKey]: next },
    });
  }, [filterState, onFilterChange]);

  const handleSortChange = useCallback((sort: SortOption) => {
    // Changing the sort key resets direction to its natural default.
    onFilterChange({ ...filterState, sort, sortDirection: DEFAULT_SORT_DIRECTION[sort] });
  }, [filterState, onFilterChange]);

  const handleToggleSortDirection = useCallback(() => {
    onFilterChange({
      ...filterState,
      sortDirection: filterState.sortDirection === 'asc' ? 'desc' : 'asc',
    });
  }, [filterState, onFilterChange]);

  const handleRemoveChip = useCallback((facetKey: string, value: string) => {
    const current = filterState.facets[facetKey] || [];
    onFilterChange({
      ...filterState,
      facets: {
        ...filterState.facets,
        [facetKey]: current.filter(v => v !== value),
      },
    });
  }, [filterState, onFilterChange]);

  const handleClearAll = useCallback(() => {
    onFilterChange({ ...EMPTY_FILTER_STATE });
  }, [onFilterChange]);

  const totalActiveChips = useMemo(
    () => Object.values(filterState.facets).reduce((sum, v) => sum + v.length, 0),
    [filterState.facets],
  );

  const hasFilters = useMemo(
    () => hasActiveFilters(filterState),
    [filterState],
  );

  const queryActive = useMemo(
    () => filterState.queryGroups !== null && filterState.queryGroups.length > 0,
    [filterState.queryGroups],
  );

  const activeChips = useMemo(() => {
    const chips: { facetKey: string; value: string }[] = [];
    for (const [key, values] of Object.entries(filterState.facets)) {
      values.forEach(v => chips.push({ facetKey: key, value: v }));
    }
    return chips;
  }, [filterState.facets]);

  return {
    handleFacetToggle,
    handleSortChange,
    handleToggleSortDirection,
    handleRemoveChip,
    handleClearAll,
    totalActiveChips,
    hasFilters,
    queryActive,
    activeChips,
  };
}
