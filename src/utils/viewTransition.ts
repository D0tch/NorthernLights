import { flushSync } from 'react-dom';

// Wrap a React-router navigation (or any DOM mutation) in
// `document.startViewTransition` so the browser can morph paired elements
// (matched by `view-transition-name`) between the old and new DOM.
//
// We can't use React Router's built-in `viewTransition` prop / option here
// because that path requires a Data Router (createBrowserRouter); the app
// uses BrowserRouter. flushSync forces the React update inside the
// transition callback to commit synchronously, so the browser captures the
// post-navigation DOM on the next paint.
//
// Falls through to a plain update when the API isn't available (Firefox
// without flag, older Safari) or when the user prefers reduced motion.
export function withViewTransition(update: () => void): void {
  if (typeof document === 'undefined') {
    update();
    return;
  }

  const reduceMotion = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const startViewTransition = (document as Document & {
    startViewTransition?: (cb: () => void) => unknown;
  }).startViewTransition;

  if (reduceMotion || typeof startViewTransition !== 'function') {
    update();
    return;
  }

  startViewTransition.call(document, () => {
    flushSync(update);
  });
}

// CSS identifiers must start with a letter and contain only letters,
// digits, hyphens, or underscores. Sanitise arbitrary IDs (UUIDs, paths,
// encoded URLs) so we can safely build per-entity transition names.
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export const albumTransitionName = (id: string | null | undefined): string | undefined =>
  id ? `vt-album-${sanitize(id)}` : undefined;

export const artistTransitionName = (id: string | null | undefined): string | undefined =>
  id ? `vt-artist-${sanitize(id)}` : undefined;

export const playlistTransitionName = (id: string | null | undefined): string | undefined =>
  id ? `vt-playlist-${sanitize(id)}` : undefined;
