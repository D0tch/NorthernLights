/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // Full 0–100 opacity scale. The `/NN` color modifier resolves against
      // this scale, so this lets any integer opacity work as a bare modifier
      // (`bg-primary/12`, `via-background/94`) instead of only the sparse
      // default steps — no bracket notation, no silently-dropped utilities.
      opacity: Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [i, (i / 100).toString()])
      ),
      // Semantic palette bridged to the CSS custom properties in index.css.
      //
      // These are declared as real Tailwind color tokens (not arbitrary
      // `[var(--color-x)]` values) so the opacity modifier works:
      // `bg-primary/10`, `ring-primary/50`, `from-background/80`, etc.
      //
      // Why this exists: Tailwind cannot slice an alpha channel out of a bare
      // `var()` — `bg-[var(--color-primary)]/10` silently compiles to nothing.
      // The `<alpha-value>` placeholder + CSS relative-color syntax lets the
      // modifier set the alpha while the hue still resolves from the runtime
      // variable, so it stays theme-aware (light/dark) automatically.
      //
      // To make another CSS-var color alpha-capable, add one line here.
      // Foreground text (`--color-text-*`) and structural glass tokens stay as
      // arbitrary `[var(...)]` values — they're always used fully opaque.
      colors: {
        primary: 'rgb(from var(--color-primary) r g b / <alpha-value>)',
        'primary-dark': 'rgb(from var(--color-primary-dark) r g b / <alpha-value>)',
        accent: 'rgb(from var(--color-accent) r g b / <alpha-value>)',
        error: 'rgb(from var(--color-error) r g b / <alpha-value>)',
        success: 'rgb(from var(--color-success) r g b / <alpha-value>)',
        warning: 'rgb(from var(--color-warning) r g b / <alpha-value>)',
        background: 'rgb(from var(--color-background) r g b / <alpha-value>)',
        surface: 'rgb(from var(--color-surface) r g b / <alpha-value>)',
        'surface-variant': 'rgb(from var(--color-surface-variant) r g b / <alpha-value>)',
      },
    },
  },
  plugins: [],
}

