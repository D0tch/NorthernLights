import { useCallback, useSyncExternalStore } from 'react';
import {
  getPwaInstallState,
  promptPwaInstall,
  subscribePwaInstall,
  type InstallPlatform,
} from '../utils/pwaInstall';

export type { InstallPlatform } from '../utils/pwaInstall';

export function usePWAInstall() {
  const { isInstalled, platform } = useSyncExternalStore(
    subscribePwaInstall,
    getPwaInstallState,
    getPwaInstallState
  );

  const install = useCallback(async () => {
    return promptPwaInstall();
  }, []);

  const canInstall = !isInstalled && (platform === 'native-prompt' || platform === 'ios-manual');

  return { canInstall, isInstalled, platform, install };
}
