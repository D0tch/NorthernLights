let applyUpdateHandler: (() => Promise<void>) | null = null;
let updateReloadScheduled = false;
let updateReloadStarted = false;

function reloadForPwaUpdate() {
  if (updateReloadStarted) return;
  updateReloadStarted = true;
  window.location.reload();
}

function schedulePwaUpdateReload() {
  if (updateReloadScheduled) return;
  updateReloadScheduled = true;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', reloadForPwaUpdate, { once: true });
  }

  window.setTimeout(reloadForPwaUpdate, 1500);
}

export function setPwaUpdateHandler(handler: () => void | Promise<void>) {
  applyUpdateHandler = async () => {
    await handler();
  };
}

export async function applyPendingPwaUpdate() {
  schedulePwaUpdateReload();

  if (applyUpdateHandler) {
    await applyUpdateHandler();
    return;
  }

  reloadForPwaUpdate();
}
