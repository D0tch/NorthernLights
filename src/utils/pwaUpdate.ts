let applyUpdateHandler: (() => Promise<void>) | null = null;
let updateInProgress = false;

export function setPwaUpdateHandler(handler: () => void | Promise<void>) {
  applyUpdateHandler = async () => {
    await handler();
  };
}

// Apply the waiting service worker and reload — exactly once.
//
// vite-plugin-pwa (prompt mode) already registers its own `controlling`
// listener that calls window.location.reload() the moment the new SW takes
// control after messageSkipWaiting(). We must NOT add a second reload here:
// two reloads firing on the same controllerchange abort each other's
// navigation, which is the white screen. And a short fallback timeout that
// reloads *before* skipWaiting lands leaves the new SW still waiting, so the
// `waiting` event re-fires and the "Update Available" prompt reappears — the
// repeated-prompt loop. So we only call skipWaiting and arm a long, single
// fallback for the rare case where the SW never activates at all.
export async function applyPendingPwaUpdate() {
  if (updateInProgress) return;
  updateInProgress = true;

  // Last-resort fallback only — long enough to never race the normal
  // controlling→reload path. The page unloads on the real reload, which cancels
  // this timer, so it fires solely when activation never happens.
  window.setTimeout(() => window.location.reload(), 10000);

  if (applyUpdateHandler) {
    await applyUpdateHandler();
    return;
  }

  // No registered handler (SW unavailable) — just reload.
  window.location.reload();
}
