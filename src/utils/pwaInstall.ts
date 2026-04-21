export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallPlatform = 'native-prompt' | 'ios-manual' | 'unsupported';

export interface PwaInstallState {
  deferredPrompt: BeforeInstallPromptEvent | null;
  isInstalled: boolean;
  platform: InstallPlatform;
}

const listeners = new Set<() => void>();

let state: PwaInstallState = {
  deferredPrompt: null,
  isInstalled: false,
  platform: 'unsupported',
};

function isIOS(): boolean {
  if (typeof window === 'undefined') return false;

  const navigatorWithStandalone = window.navigator as Navigator & { standalone?: boolean };
  const classicIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) && !('MSStream' in window);
  const iPadDesktopMode = navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1;

  return classicIOS || iPadDesktopMode || navigatorWithStandalone.standalone === true;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;

  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function setState(next: Partial<PwaInstallState>) {
  state = { ...state, ...next };
  listeners.forEach(listener => listener());
}

export function getPwaInstallState(): PwaInstallState {
  return state;
}

export function subscribePwaInstall(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function initPwaInstallCapture() {
  if (typeof window === 'undefined') return;

  if (isStandalone()) {
    setState({ isInstalled: true, platform: 'unsupported', deferredPrompt: null });
    return;
  }

  if (isIOS()) {
    setState({ platform: 'ios-manual' });
  }
}

export async function promptPwaInstall() {
  const promptEvent = state.deferredPrompt;
  if (!promptEvent) return false;

  await promptEvent.prompt();
  const { outcome } = await promptEvent.userChoice;
  setState({ deferredPrompt: null, platform: 'unsupported' });
  return outcome === 'accepted';
}

if (typeof window !== 'undefined') {
  initPwaInstallCapture();

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    setState({
      deferredPrompt: event as BeforeInstallPromptEvent,
      platform: 'native-prompt',
    });
  });

  window.addEventListener('appinstalled', () => {
    setState({
      deferredPrompt: null,
      isInstalled: true,
      platform: 'unsupported',
    });
  });
}
