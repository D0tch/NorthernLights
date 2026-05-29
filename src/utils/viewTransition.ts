import { flushSync } from 'react-dom';

// ─── View transition helper ─────────────────────────────────────────────────
//
// Wraps a React-router navigation in `document.startViewTransition` so the
// browser can morph paired elements (matched by `view-transition-name`)
// between the old and new DOM.
//
// We can't use React Router's built-in `viewTransition` option because that
// path requires a Data Router (createBrowserRouter); this app uses
// BrowserRouter. So we drive the transition by hand.
//
// THE FREEZE WE'RE GUARDING AGAINST
// ---------------------------------
// `flushSync(update)` forces the navigation to commit synchronously inside the
// transition callback, so the browser captures the post-navigation DOM. But if
// the destination route is a `React.lazy` chunk that hasn't loaded yet, that
// synchronous render SUSPENDS. React 18's rule for "a component suspended while
// responding to synchronous input" is to keep the OLD UI rather than show a
// fallback — and the view transition has already laid the old-page snapshot on
// top. The page is then frozen under that overlay until the chunk resolves
// (and if the request stalls, effectively forever).
//
// THE FIX
// -------
//   1. Never start the transition until the destination chunk is loaded
//      (callers pass the chunk's import promise as `ready`). With the chunk
//      resolved, the synchronous render can't suspend.
//   2. If the chunk is slow or fails, just navigate plainly — no transition,
//      no freeze.
//   3. A watchdog force-completes any transition whose compositor stalls, so
//      an overlay can never strand the page regardless of cause.
//   4. Overlapping transitions are collapsed (a second navigation skips the
//      first), and a hidden tab / thrown API call falls back to plain update.

interface ViewTransitionLike {
  readonly finished: Promise<void>;
  readonly ready: Promise<void>;
  readonly updateCallbackDone: Promise<void>;
  skipTransition: () => void;
}

type StartViewTransition = (callback: () => void) => ViewTransitionLike;

// A healthy transition resolves in roughly the CSS animation duration (280ms).
// The watchdog sits comfortably above that so it only fires on genuine stalls.
const WATCHDOG_MS = 600;
// Cap how long we'll wait for the destination chunk before giving up on the
// morph and navigating plainly. An SW-cached chunk resolves in <16ms; this only
// matters on a cold, slow network — where we'd rather navigate than stall.
const READY_TIMEOUT_MS = 800;

let activeTransition: ViewTransitionLike | null = null;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getStartViewTransition(): StartViewTransition | null {
  if (typeof document === 'undefined') return null;
  const fn = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  return typeof fn === 'function' ? fn.bind(document) : null;
}

// Run `onReady` once `ready` settles successfully; run `onFail` if it rejects
// or doesn't settle within READY_TIMEOUT_MS. Exactly one of the two fires.
function whenReady(ready: Promise<unknown> | undefined, onReady: () => void, onFail: () => void): void {
  if (!ready) { onReady(); return; }
  let settled = false;
  const succeed = () => { if (!settled) { settled = true; onReady(); } };
  const fail = () => { if (!settled) { settled = true; onFail(); } };
  ready.then(succeed, fail);
  if (typeof window !== 'undefined') {
    window.setTimeout(fail, READY_TIMEOUT_MS);
  }
}

/**
 * Navigate (or mutate the DOM) with a view transition, safely.
 *
 * @param update  The DOM-mutating callback — typically `() => navigate(to, opts)`.
 * @param ready   Optional promise that resolves when the destination's lazy
 *                chunk is loaded. When provided, the transition only starts
 *                after it resolves; if it rejects or times out, `update` runs
 *                with no transition. Pass the matching `prefetchXDetail()`
 *                promise here.
 */
export function withViewTransition(update: () => void, ready?: Promise<unknown>): void {
  const startViewTransition = getStartViewTransition();

  // No API, reduced motion, or hidden tab → plain navigation. Still honour
  // `ready` so a cold-chunk navigation doesn't render a flash of nothing, but
  // never block on it longer than the timeout.
  if (!startViewTransition || prefersReducedMotion() || (typeof document !== 'undefined' && document.hidden)) {
    whenReady(ready, update, update);
    return;
  }

  const beginTransition = () => {
    // Collapse overlapping transitions — two live ones is a known way to
    // strand the old-page overlay.
    if (activeTransition) {
      try { activeTransition.skipTransition(); } catch { /* ignore */ }
      activeTransition = null;
    }

    let transition: ViewTransitionLike;
    try {
      transition = startViewTransition(() => { flushSync(update); });
    } catch {
      // startViewTransition threw synchronously — ensure navigation still happens.
      update();
      return;
    }

    activeTransition = transition;

    // Skipped/interrupted transitions reject `ready` (and sometimes `finished`).
    // The DOM was already updated by the callback, so these rejections are
    // noise — swallow them to avoid unhandled-rejection warnings.
    transition.ready?.catch?.(() => {});

    const watchdog = (typeof window !== 'undefined')
      ? window.setTimeout(() => { try { transition.skipTransition(); } catch { /* ignore */ } }, WATCHDOG_MS)
      : null;

    const cleanup = () => {
      if (watchdog !== null) window.clearTimeout(watchdog);
      if (activeTransition === transition) activeTransition = null;
    };
    transition.finished.then(cleanup, cleanup);
  };

  // Start the transition only once the destination chunk is ready; otherwise
  // navigate plainly (no freeze, no morph).
  whenReady(ready, beginTransition, update);
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
