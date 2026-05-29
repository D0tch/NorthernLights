import {
  withViewTransition,
  albumTransitionName,
  artistTransitionName,
  playlistTransitionName,
} from '../viewTransition';

// Flush queued microtasks (promise callbacks) so `ready.then(...)` handlers run
// before we make assertions or advance fake timers.
const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

interface FakeTransition {
  finished: Promise<void>;
  ready: Promise<void>;
  updateCallbackDone: Promise<void>;
  skipTransition: jest.Mock;
}

function makeTransition(overrides: Partial<FakeTransition> = {}): FakeTransition {
  return {
    finished: Promise.resolve(),
    ready: Promise.resolve(),
    updateCallbackDone: Promise.resolve(),
    skipTransition: jest.fn(),
    ...overrides,
  };
}

describe('withViewTransition', () => {
  // The DOM lib types `startViewTransition` / `matchMedia` strictly; in tests we
  // need to install and remove fakes freely, so reach for them via `any`.
  const docAny = document as unknown as Record<string, unknown>;
  const winAny = window as unknown as Record<string, unknown>;
  const setStart = (fn: (cb: () => void) => FakeTransition) => { docAny.startViewTransition = fn; };
  const clearStart = () => { delete docAny.startViewTransition; };

  beforeEach(() => {
    jest.useFakeTimers();
    clearStart();
    // jsdom usually leaves matchMedia undefined; make that explicit.
    delete winAny.matchMedia;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    clearStart();
    delete winAny.matchMedia;
  });

  it('runs the update synchronously when the API is unavailable and no readiness is given', () => {
    const update = jest.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('runs the update after readiness resolves when the API is unavailable', async () => {
    const update = jest.fn();
    withViewTransition(update, Promise.resolve());
    expect(update).not.toHaveBeenCalled(); // deferred until the promise settles
    await flushMicrotasks();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('still runs the update when readiness rejects', async () => {
    const update = jest.fn();
    withViewTransition(update, Promise.reject(new Error('chunk failed')));
    await flushMicrotasks();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('starts a transition (and commits the update) when the API is present and readiness resolves', async () => {
    const transition = makeTransition();
    const start = jest.fn((cb: () => void) => { cb(); return transition; });
    setStart(start);

    const update = jest.fn();
    withViewTransition(update, Promise.resolve());
    await flushMicrotasks();

    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('skips the transition and navigates plainly when readiness rejects', async () => {
    const start = jest.fn((cb: () => void) => { cb(); return makeTransition(); });
    setStart(start);

    const update = jest.fn();
    withViewTransition(update, Promise.reject(new Error('cold chunk')));
    await flushMicrotasks();

    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('skips the transition entirely under prefers-reduced-motion', async () => {
    const start = jest.fn((cb: () => void) => { cb(); return makeTransition(); });
    setStart(start);
    winAny.matchMedia = jest.fn().mockReturnValue({ matches: true });

    const update = jest.fn();
    withViewTransition(update, Promise.resolve());
    await flushMicrotasks();

    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('force-completes a stalled transition via the watchdog', async () => {
    const skipTransition = jest.fn();
    // A transition whose finished/ready never settle — simulates a stalled compositor.
    const transition = makeTransition({
      finished: new Promise<void>(() => {}),
      ready: new Promise<void>(() => {}),
      skipTransition,
    });
    setStart((cb: () => void) => { cb(); return transition; });

    const update = jest.fn();
    withViewTransition(update, Promise.resolve());
    await flushMicrotasks(); // let readiness resolve so the transition begins

    expect(skipTransition).not.toHaveBeenCalled();
    jest.advanceTimersByTime(600); // WATCHDOG_MS
    expect(skipTransition).toHaveBeenCalledTimes(1);
  });
});

describe('transition name helpers', () => {
  it('build prefixed names from ids', () => {
    expect(albumTransitionName('abc')).toBe('vt-album-abc');
    expect(artistTransitionName('abc')).toBe('vt-artist-abc');
    expect(playlistTransitionName('abc')).toBe('vt-playlist-abc');
  });

  it('sanitise characters that are illegal in CSS identifiers', () => {
    expect(albumTransitionName('a/b c:d')).toBe('vt-album-a_b_c_d');
  });

  it('return undefined for empty ids', () => {
    expect(albumTransitionName(undefined)).toBeUndefined();
    expect(artistTransitionName(null)).toBeUndefined();
    expect(playlistTransitionName('')).toBeUndefined();
  });
});
