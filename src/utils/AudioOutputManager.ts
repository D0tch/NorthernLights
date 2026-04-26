export interface AudioOutputDevice {
  deviceId: string;
  label: string;
  isDefault: boolean;
}

export interface AudioOutputDeviceState {
  supported: boolean;
  pickerSupported: boolean;
  devices: AudioOutputDevice[];
  deviceId: string;
  label: string;
  active: boolean;
  selecting: boolean;
  error: string | null;
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

const DEFAULT_STATE: AudioOutputDeviceState = {
  supported: false,
  pickerSupported: false,
  devices: [{ deviceId: '', label: 'System default', isDefault: true }],
  deviceId: '',
  label: '',
  active: false,
  selecting: false,
  error: null,
};

class AudioOutputManager {
  private static instance: AudioOutputManager;
  private state: AudioOutputDeviceState = { ...DEFAULT_STATE };
  private listeners = new Set<AudioOutputListener>();
  private registeredElements = new Set<SinkAudioElement>();
  private initialized = false;

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
      this.setState({
        devices: this.normalizeOutputDevices(devices),
        error: null,
      });
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

  public async applyToRegisteredElements(): Promise<boolean> {
    const results = await Promise.all(Array.from(this.registeredElements, (element) => this.applyToElement(element)));
    return results.every(Boolean);
  }

  private async applyToElement(element: SinkAudioElement): Promise<boolean> {
    if (!this.isSupportedForElement(element)) return true;

    try {
      await element.setSinkId?.(this.state.active ? this.state.deviceId : '');
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

  private isRoutingSupported(): boolean {
    const probe = typeof Audio !== 'undefined' ? (Audio.prototype as SinkAudioElement) : null;
    return typeof probe?.setSinkId === 'function';
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
