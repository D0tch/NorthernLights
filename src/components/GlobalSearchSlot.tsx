import React from 'react';

const GlobalSearch = React.lazy(() => import('./GlobalSearch').then(module => ({ default: module.GlobalSearch })));

const SearchFallback: React.FC = () => (
  <div className="h-9 w-[104px] flex-shrink-0 rounded-full border border-black/10 dark:border-white/15 bg-black/10 dark:bg-white/10" />
);

// The global search entry point, wrapped in its own Suspense boundary so the
// search chunk loads lazily. Rendered by both the mobile header and desktop tab
// bar.
export const GlobalSearchSlot: React.FC = () => (
  <React.Suspense fallback={<SearchFallback />}>
    <GlobalSearch />
  </React.Suspense>
);

export default GlobalSearchSlot;
