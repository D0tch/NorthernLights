// Whether the OS is expected to route the phone's hardware volume keys to an
// active cast session. True only on modern Android: routing worked for years,
// broke on Android 12 (the Sonos ruling) and was restored on 12L/13+ via Play
// services. Older versions vary by OEM, iOS browsers can't run the Cast web
// sender at all, and desktop has no routing — those get an on-screen slider.
//
// Detection uses User-Agent Client Hints: the plain UA string is useless here
// (Chrome's reduced UA reports "Android 10; K" regardless of the real
// version). Browsers without UA-CH (Safari, Firefox) return false.
export async function hardwareKeysControlCastVolume(): Promise<boolean> {
  const uaData = (navigator as unknown as {
    userAgentData?: {
      getHighEntropyValues?: (hints: string[]) => Promise<{ platform?: string; platformVersion?: string }>;
    };
  }).userAgentData;
  if (!uaData?.getHighEntropyValues) return false;

  try {
    const { platform, platformVersion } = await uaData.getHighEntropyValues(['platformVersion']);
    if (platform !== 'Android') return false;
    // "12.1.0" → 12.1, "13.0.0" → 13. Require Android 12L (12.1) or newer.
    return (parseFloat(platformVersion ?? '') || 0) >= 12.1;
  } catch {
    return false;
  }
}
