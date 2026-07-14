export interface AudioOutputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

export type AudioOutputPermission = 'unknown' | 'granted' | 'denied' | 'unavailable' | 'unsupported';

export interface AudioOutputDeviceState {
  supported: boolean;
  pickerSupported: boolean;
  devices: AudioOutputDevice[];
  deviceId: string;
  label: string;
  active: boolean;
  selecting: boolean;
  error: string | null;
  permission: AudioOutputPermission;
  requestingAccess: boolean;
}

type AudioOutputListener = (state: AudioOutputDeviceState) => void;

type SelectAudioOutputOptions = {
  deviceId?: string;
};

type MediaDevicesWithOutputSelection = MediaDevices & {
  selectAudioOutput?: (options?: SelectAudioOutputOptions) => Promise<MediaDeviceInfo>;
};

type SinkAudioElement = HTMLAudioElement & {
  sinkId?: string;
  setSinkId?: (sinkId: string) => Promise<void>;
};

type SinkAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

const DEFAULT_STATE: AudioOutputDeviceState = {
  supported: false,
  pickerSupported: false,
  devices: [{ deviceId: '', label: 'System default', isDefault: true }],
  deviceId: '',
  label: '',
  active: false,
  selecting: false,
  error: null,
  permission: 'unknown',
  requestingAccess: false,
};

class AudioOutputManager {
  private static instance: AudioOutputManager;
  private state: AudioOutputDeviceState = { ...DEFAULT_STATE };
  private listeners = new Set<AudioOutputListener>();
  private registeredElements = new Set<SinkAudioElement>();
  private bridgeElements = new Set<SinkAudioElement>();
  private registeredContexts = new Set<SinkAudioContext>();
  private initialized = false;
  private accessRequest: Promise<AudioOutputDeviceState> | null = null;
  private persistedReactivationDone = false;
  private microphonePermissionStatus: PermissionStatus | null = null;

  public static getInstance(): AudioOutputManager {
    if (!AudioOutputManager.instance) {
      AudioOutputManager.instance = new AudioOutputManager();
    }
    return AudioOutputManager.instance;
  }

  public initialize(deviceId = '', label = ''): AudioOutputDeviceState {
    if (this.initialized) return this.state;
    this.initialized = true;

    const supported = this.isRoutingSupported();
    this.state = {
      supported,
      pickerSupported: this.isPickerSupported(),
      devices: [{ deviceId: '', label: 'System default', isDefault: true }],
      deviceId: supported ? deviceId : '',
      label: supported ? label : '',
      active: false,
      selecting: false,
      error: null,
      permission: 'unknown',
      requestingAccess: false,
    };

    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange);
    }

    void this.refreshDevices();
    return this.state;
  }

  public getState(): AudioOutputDeviceState {
    return this.state;
  }

  public subscribe(listener: AudioOutputListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  public registerElement(element: HTMLAudioElement): void {
    const sinkElement = element as SinkAudioElement;
    this.registeredElements.add(sinkElement);
    if (this.state.active) {
      void this.applyToElement(sinkElement);
    }
  }

  public unregisterElement(element: HTMLAudioElement): void {
    this.registeredElements.delete(element as SinkAudioElement);
    this.bridgeElements.delete(element as SinkAudioElement);
  }

  /**
   * Register the MediaStream bridge element used on browsers without
   * AudioContext.setSinkId (Firefox, Safari). All graph audio exits through
   * it, so its sink is authoritative the way a context sink is on Chromium.
   */
  public registerBridgeElement(element: HTMLAudioElement): void {
    const sinkElement = element as SinkAudioElement;
    this.bridgeElements.add(sinkElement);
    if (this.state.active) {
      void this.applyToElement(sinkElement);
    }
  }

  public registerContext(context: AudioContext): void {
    const sinkContext = context as SinkAudioContext;
    this.registeredContexts.add(sinkContext);
    if (this.state.active) {
      void this.applyToContext(sinkContext);
    }
  }

  public unregisterContext(context: AudioContext): void {
    this.registeredContexts.delete(context as SinkAudioContext);
  }

  public async refreshDevices(): Promise<AudioOutputDeviceState> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      this.setState({
        devices: [{ deviceId: '', label: 'System default', isDefault: true }],
      });
      return this.state;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      // Browsers only reveal device labels once a media permission is granted,
      // so a labelled output doubles as a permission probe.
      const labelsKnown = devices.some((device) => device.kind === 'audiooutput' && device.label !== '');
      // Note: don't clear state.error here — refresh runs right after routing
      // failures and would wipe the message before the user ever sees it.
      this.setState({
        devices: this.normalizeOutputDevices(devices),
        ...(labelsKnown ? { permission: 'granted' as const } : {}),
      });
      if (labelsKnown) {
        this.maybeReactivatePersistedDevice();
      }
    } catch (error) {
      this.setState({
        devices: [{ deviceId: '', label: 'System default', isDefault: true }],
        error: this.getErrorMessage(error),
      });
    }

    return this.state;
  }

  public async selectOutputDevice(preferredDeviceId?: string): Promise<AudioOutputDeviceState> {
    if (!preferredDeviceId) {
      if (this.isPickerSupported()) {
        return this.openOutputPicker();
      }
      return this.clearOutputDevice();
    }

    if (!this.isRoutingSupported()) {
      this.setState({
        supported: false,
        error: 'This browser can list audio outputs but cannot route app audio to a selected output.',
      });
      return this.state;
    }

    this.setState({ supported: true, selecting: true, error: null });

    try {
      const listedDevice = this.state.devices.find((device) => device.deviceId === preferredDeviceId);
      const nextState: Partial<AudioOutputDeviceState> = {
        deviceId: preferredDeviceId,
        label: listedDevice?.label || 'Selected output',
        active: true,
        selecting: false,
        error: null,
      };
      this.setState(nextState);
      const applied = await this.applyToRegisteredElements();
      if (!applied) {
        this.setState({
          deviceId: '',
          label: '',
          active: false,
          error: this.state.error || 'Could not route audio to the selected output.',
        });
      }
      await this.refreshDevices();
      return this.state;
    } catch (error) {
      this.setState({
        selecting: false,
        error: this.getErrorMessage(error),
      });
      return this.state;
    }
  }

  public async openOutputPicker(): Promise<AudioOutputDeviceState> {
    if (!this.isPickerSupported()) {
      this.setState({
        error: 'Native output picker is not available in this browser. Use the output list or the operating system picker.',
      });
      await this.refreshDevices();
      return this.state;
    }

    if (!this.isRoutingSupported()) {
      this.setState({
        error: 'This browser cannot route app audio to a selected output.',
      });
      return this.state;
    }

    this.setState({ selecting: true, error: null });

    try {
      const mediaDevices = navigator.mediaDevices as MediaDevicesWithOutputSelection;
      const device = await mediaDevices.selectAudioOutput?.(
        this.state.deviceId ? { deviceId: this.state.deviceId } : undefined
      );

      if (!device?.deviceId) {
        throw new Error('No audio output device was selected.');
      }

      this.setState({
        deviceId: device.deviceId,
        label: device.label || 'Selected output',
        active: true,
        selecting: false,
        error: null,
      });
      const applied = await this.applyToRegisteredElements();
      if (!applied) {
        this.setState({
          deviceId: '',
          label: '',
          active: false,
          error: this.state.error || 'Could not route audio to the selected output.',
        });
      }
      await this.refreshDevices();
      return this.state;
    } catch (error) {
      this.setState({
        selecting: false,
        error: this.getErrorMessage(error),
      });
      await this.refreshDevices();
      return this.state;
    }
  }

  public async clearOutputDevice(): Promise<AudioOutputDeviceState> {
    this.setState({
      deviceId: '',
      label: '',
      active: false,
      selecting: false,
      error: null,
    });
    await this.applyToRegisteredElements();
    await this.refreshDevices();
    return this.state;
  }

  /**
   * Make sure the app is allowed to see device labels and route audio to
   * non-default outputs. Browsers gate both behind a media-capture permission,
   * so this requests (and immediately releases) a microphone stream once.
   */
  public async ensureDeviceAccess(): Promise<AudioOutputDeviceState> {
    if (!this.accessRequest) {
      this.accessRequest = this.requestDeviceAccess().finally(() => {
        this.accessRequest = null;
      });
    }
    return this.accessRequest;
  }

  private async requestDeviceAccess(): Promise<AudioOutputDeviceState> {
    if (
      !this.isRoutingSupported() ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      // Labels are useless if routing can't work — don't prompt for a mic.
      this.setState({ permission: 'unsupported' });
      return this.state;
    }

    await this.refreshDevices();
    if (this.state.permission === 'granted') return this.state;

    if (this.isPickerSupported()) {
      // Firefox grants speaker access per-device through its native
      // selectAudioOutput picker — a microphone grant reveals nothing there,
      // so don't prompt. The UI offers the picker instead.
      return this.state;
    }

    // Skip a prompt the browser would auto-reject, and pick up grants made
    // later through the browser's site settings.
    try {
      const status = await navigator.permissions?.query?.({ name: 'microphone' as PermissionName });
      if (status && !this.microphonePermissionStatus) {
        this.microphonePermissionStatus = status;
        status.onchange = () => {
          if (status.state === 'denied') {
            this.setState({ permission: 'denied' });
          } else {
            void this.refreshDevices();
          }
        };
      }
      if (status?.state === 'denied') {
        this.setState({ permission: 'denied' });
        return this.state;
      }
    } catch {
      // Permissions API can't describe 'microphone' here — fall through to the prompt.
    }

    this.setState({ requestingAccess: true, error: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      this.setState({ permission: 'granted', requestingAccess: false, error: null });
      await this.refreshDevices();
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        this.setState({ permission: 'denied', requestingAccess: false });
      } else if (name === 'NotFoundError') {
        this.setState({ permission: 'unavailable', requestingAccess: false });
      } else {
        this.setState({ requestingAccess: false, error: this.getErrorMessage(error) });
      }
    }
    return this.state;
  }

  /**
   * A persisted selection restores as inactive (deviceId set, active false).
   * Once labels are known — i.e. routing is authorized — reactivate it so the
   * saved device actually takes effect again. One-shot: if the device isn't
   * connected at that point the saved selection is treated as stale.
   */
  private maybeReactivatePersistedDevice(): void {
    if (this.persistedReactivationDone) return;
    this.persistedReactivationDone = true;
    const { active, deviceId, devices } = this.state;
    if (active || !deviceId) return;
    if (!devices.some((device) => !device.isDefault && device.deviceId === deviceId)) return;
    void this.selectOutputDevice(deviceId);
  }

  public async applyToRegisteredElements(): Promise<boolean> {
    const elementResults = await Promise.all(
      Array.from(this.registeredElements, (element) => this.applyToElement(element))
    );
    const bridgeResults = await Promise.all(
      Array.from(this.bridgeElements, (element) => this.applyToElement(element))
    );
    const contextResults = await Promise.all(
      Array.from(this.registeredContexts, (context) => this.applyToContext(context))
    );
    // Whatever the graph exits through is authoritative: the context sink on
    // Chromium, the bridge element on Firefox/Safari. Media elements captured
    // into the graph are silent, so their sink failures must not revert the
    // selection (Chrome rejects setSinkId with AbortError on a playing
    // captured element).
    if (contextResults.length > 0) return contextResults.every(Boolean);
    if (bridgeResults.length > 0) return bridgeResults.every(Boolean);
    return elementResults.every(Boolean);
  }

  private async applyToElement(element: SinkAudioElement): Promise<boolean> {
    if (!this.isSupportedForElement(element)) return true;

    try {
      await element.setSinkId?.(this.state.active ? this.state.deviceId : '');
      return true;
    } catch (error) {
      console.warn('[AudioOutput] element setSinkId failed:', error);
      // AbortError = the element is WebAudio-captured and silent; non-fatal.
      return error instanceof DOMException && error.name === 'AbortError';
    }
  }

  private async applyToContext(context: SinkAudioContext): Promise<boolean> {
    if (typeof context.setSinkId !== 'function') {
      // The loudness graph keeps playing on the default device without a
      // context sink, so an active selection cannot be honored.
      return !this.state.active;
    }

    try {
      await context.setSinkId(this.state.active ? this.state.deviceId : '');
      return true;
    } catch (error) {
      this.setState({
        error: this.getErrorMessage(error),
      });
      return false;
    }
  }

  private handleDeviceChange = (): void => {
    void this.refreshDevices()
      .then((state) => {
        if (!state.active) return;

        const selected = state.devices.find((device) => device.deviceId === state.deviceId);
        if (selected) return;
        this.setState({
          deviceId: '',
          label: '',
          active: false,
          selecting: false,
          error: 'Selected audio output is no longer available.',
        });
        void this.applyToRegisteredElements();
      })
      .catch((error) => {
        this.setState({ error: this.getErrorMessage(error) });
      });
  };

  private setState(next: Partial<AudioOutputDeviceState>): void {
    this.state = {
      ...this.state,
      ...next,
      supported: this.isRoutingSupported(),
      pickerSupported: this.isPickerSupported(),
    };
    this.listeners.forEach((listener) => listener(this.state));
  }

  private normalizeOutputDevices(devices: MediaDeviceInfo[]): AudioOutputDevice[] {
    const outputs = devices.filter((device) => device.kind === 'audiooutput');
    const defaultDevice = outputs.find((device) => device.deviceId === 'default');
    const normalized: AudioOutputDevice[] = [{
      deviceId: '',
      label: defaultDevice?.label || 'System default',
      isDefault: true,
    }];
    const seen = new Set(['', 'default']);

    outputs.forEach((device, index) => {
      if (!device.deviceId || seen.has(device.deviceId)) return;
      seen.add(device.deviceId);
      normalized.push({
        deviceId: device.deviceId,
        label: device.label || `Output ${index + 1}`,
        isDefault: false,
      });
    });

    return normalized;
  }

  public isElementSinkSupported(): boolean {
    const probe = typeof Audio !== 'undefined' ? (Audio.prototype as SinkAudioElement) : null;
    return typeof probe?.setSinkId === 'function';
  }

  public isContextSinkSupported(): boolean {
    if (typeof AudioContext === 'undefined') return false;
    return typeof (AudioContext.prototype as SinkAudioContext).setSinkId === 'function';
  }

  /**
   * Playback routes through the loudness AudioContext once the first user
   * gesture lands (PlaybackManager.ensureAudioContext), which bypasses the
   * media elements' own sinks. Routing works when the graph's exit can be
   * re-pointed: directly via AudioContext.setSinkId (Chromium), or via the
   * MediaStream bridge element PlaybackManager installs when only
   * element-level setSinkId exists (Firefox 116+, Safari 18.4+).
   */
  private isRoutingSupported(): boolean {
    return this.isContextSinkSupported() || this.isElementSinkSupported();
  }

  private isPickerSupported(): boolean {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return false;
    const mediaDevices = navigator.mediaDevices as MediaDevicesWithOutputSelection;
    return typeof mediaDevices.selectAudioOutput === 'function';
  }

  private isSupportedForElement(element: SinkAudioElement): boolean {
    return this.isRoutingSupported() && typeof element.setSinkId === 'function';
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof DOMException) return error.message || error.name;
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    return 'Could not select audio output device.';
  }
}

export const audioOutputManager = AudioOutputManager.getInstance();
