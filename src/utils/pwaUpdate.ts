let applyUpdateHandler: (() => Promise<void>) | null = null;

export function setPwaUpdateHandler(handler: () => void | Promise<void>) {
  applyUpdateHandler = async () => {
    await handler();
  };
}

export async function applyPendingPwaUpdate() {
  if (applyUpdateHandler) {
    await applyUpdateHandler();
    return;
  }

  window.location.reload();
}
