import React from 'react';
import { usePlayerStore, ThemeName, CUSTOM_THEME_VARS, DEFAULT_CUSTOM_THEME_CSS } from '../../store/index';

const THEME_OPTIONS: { value: ThemeName; label: string; description: string }[] = [
    { value: 'light', label: 'Daylight', description: 'Frosted glass, light background' },
    { value: 'dark', label: 'Aurora', description: 'Oxygen green over near-black' },
    { value: 'midnight', label: 'Midnight', description: 'Icy polar blues and cyan' },
    { value: 'solstice', label: 'Solstice', description: 'Warm copper and ember red' },
    { value: 'nebula', label: 'Nebula', description: 'Deep violet and magenta' },
    { value: 'crimson', label: 'Crimson', description: 'Blood-red aurora, rose accents' },
    { value: 'custom', label: 'Custom', description: 'Your own CSS variable overrides' },
];

export const AppearanceTab: React.FC = () => {
    const theme = usePlayerStore(state => state.theme);
    const setTheme = usePlayerStore(state => state.setTheme);
    const customThemeCss = usePlayerStore(state => state.customThemeCss);
    const setCustomThemeCss = usePlayerStore(state => state.setCustomThemeCss);
    const reducedMotion = usePlayerStore(state => state.reducedMotion);
    const setReducedMotion = usePlayerStore(state => state.setReducedMotion);
    const mobileVideoBackgrounds = usePlayerStore(state => state.mobileVideoBackgrounds);
    const setMobileVideoBackgrounds = usePlayerStore(state => state.setMobileVideoBackgrounds);

    return (
        <div className="settings-section mb-8">
            <div className="settings-section-header mb-4">
                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Appearance</h3>
            </div>

            <div className="mb-6">
                <label htmlFor="theme-select" className="block text-sm font-medium text-[var(--color-text-primary)] mb-2">Theme</label>
                <select
                    id="theme-select"
                    value={theme}
                    onChange={e => setTheme(e.target.value as ThemeName)}
                    className="w-full p-2 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] focus:outline-none"
                >
                    {THEME_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                </select>
                <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                    {THEME_OPTIONS.find(option => option.value === theme)?.description}
                </p>
            </div>

            {theme === 'custom' && (
                <div className="mb-6">
                    <div className="flex items-center justify-between mb-2">
                        <label htmlFor="custom-theme-css" className="block text-sm font-medium text-[var(--color-text-primary)]">Custom CSS variables</label>
                        <button
                            type="button"
                            onClick={() => setCustomThemeCss(DEFAULT_CUSTOM_THEME_CSS)}
                            className="text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-ui"
                        >
                            Reset
                        </button>
                    </div>
                    <textarea
                        id="custom-theme-css"
                        spellCheck={false}
                        value={customThemeCss}
                        onChange={e => setCustomThemeCss(e.target.value)}
                        rows={12}
                        className="w-full p-3 rounded-lg border border-[var(--glass-border)] bg-[var(--color-surface)] text-[var(--color-text-primary)] font-mono text-xs leading-relaxed resize-y focus:outline-none"
                    />
                    <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                        One <code>--variable: value;</code> declaration per line, applied live over the Aurora theme. Available variables: {CUSTOM_THEME_VARS.join(', ')}.
                    </p>
                </div>
            )}

            <div className="appearance-toggle-row">
                <div>
                    <h5>Reduced motion</h5>
                    <p>Minimize animations and transitions.</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={reducedMotion}
                    aria-label="Reduced motion"
                    onClick={() => setReducedMotion(!reducedMotion)}
                    className="account-switch"
                    data-state={reducedMotion ? 'on' : 'off'}
                >
                    <span className="account-switch__thumb" />
                </button>
            </div>

            <div className="appearance-toggle-row">
                <div>
                    <h5>Music video backgrounds</h5>
                    <p>On mobile, play a track's matched music video (muted) behind the now-playing screen.</p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={mobileVideoBackgrounds}
                    aria-label="Music video backgrounds"
                    onClick={() => setMobileVideoBackgrounds(!mobileVideoBackgrounds)}
                    className="account-switch"
                    data-state={mobileVideoBackgrounds ? 'on' : 'off'}
                >
                    <span className="account-switch__thumb" />
                </button>
            </div>
        </div>
    );
};
