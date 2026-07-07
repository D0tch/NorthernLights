import { RefObject, useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

// Per-route scroll offsets for the app's single scroll viewport (MainContent).
// Module-scoped so it survives route changes; cleared on a full page reload,
// which is the desired behavior. Bounded by the number of distinct routes
// visited in a session.
const positions = new Map<string, number>();

const MAX_RESTORE_FRAMES = 30; // ~0.5s: enough for lazy/virtualized content to reach full height

/**
 * Manual scroll restoration for the app shell's single scroll viewport.
 * react-router-dom v7 is used here via BrowserRouter (not the data router), so
 * the built-in <ScrollRestoration> isn't available — this reproduces it:
 *
 * - Saves the viewport's scrollTop per route (pathname + search) as the user scrolls.
 * - On back/forward (`POP`), restores the saved offset, retrying across a few
 *   frames because virtualized grids and entity-first/lazy views don't reach
 *   full height until after mount (so a single set would clamp short).
 * - On a fresh forward navigation (`PUSH`/`REPLACE`), resets to the top.
 *
 * Pass a ref to the element that actually scrolls (the `overflow-y-auto`
 * viewport). All routed pages share it, and the virtualizer scrolls it too, so
 * one offset covers every view.
 */
export function useScrollRestoration(scrollRef: RefObject<HTMLElement | null>): void {
  const location = useLocation();
  const navType = useNavigationType();
  const key = location.pathname + location.search;
  // Live key so the single scroll listener always saves under the current route,
  // regardless of when async scroll events (including restore's own) fire.
  const keyRef = useRef(key);

  // One scroll listener for the viewport's lifetime; saves under the live key,
  // rAF-throttled.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        positions.set(keyRef.current, el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRef]);

  // Restore (POP) or reset (PUSH/REPLACE) when the route changes.
  useLayoutEffect(() => {
    keyRef.current = key;
    const el = scrollRef.current;
    if (!el) return;

    const target = navType === 'POP' ? (positions.get(key) ?? 0) : 0;
    if (target <= 0) {
      el.scrollTop = 0;
      return;
    }

    let cancelled = false;
    let frames = 0;
    const stop = () => { cancelled = true; };
    // Abort the moment the user tries to scroll, so the retry loop never fights them.
    el.addEventListener('wheel', stop, { passive: true, once: true });
    el.addEventListener('touchstart', stop, { passive: true, once: true });
    window.addEventListener('keydown', stop, { once: true });

    const restore = () => {
      if (cancelled) return;
      el.scrollTop = target;
      // scrollTop clamps to the current max; if we couldn't reach the target the
      // content isn't tall enough yet (lazy/virtualized) — retry next frame.
      if (el.scrollTop < target - 1 && ++frames < MAX_RESTORE_FRAMES) {
        requestAnimationFrame(restore);
      }
    };
    requestAnimationFrame(restore);
    return () => {
      cancelled = true;
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchstart', stop);
      window.removeEventListener('keydown', stop);
    };
  }, [key, navType, scrollRef]);
}
