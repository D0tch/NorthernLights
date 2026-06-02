// Maps any pathname to the nav tab that should read as active. Shared by the
// mobile and desktop tab bars so the two stay in lockstep (it used to be
// duplicated verbatim in both).
export const getActiveTab = (path: string): string => {
  if (path === '/library' || path === '/') return '/library';
  if (path.startsWith('/library/artist')) return '/library/artists';
  if (path.startsWith('/library/album')) return '/library/albums';
  if (path.startsWith('/library/genre')) return '/library/genres';
  if (path.startsWith('/playlists')) return '/playlists';
  return '/library';
};
