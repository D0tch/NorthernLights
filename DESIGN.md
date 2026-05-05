# Design.md — Aurora Player

Single source of truth for design direction. Tokens live in `src/index.css` (`:root` and `.dark`); this document explains the *intent* behind them so future work stays coherent.

---

## 1. Brand Identity

**Name:** Aurora Player.
**Metaphor:** Northern Lights over a deep night sky. Music as a luminous, drifting field of color.
**Personality:** Editorial, premium, calm. Restrained chrome that lets album art and motion carry the energy. Never neon, never toy-like.
**Reference points:** Apple Music's editorial typography, iOS Air glass, premium hi-fi UIs (Roon, Sonos S2). Avoid Spotify-flat, avoid Material density.

The two modes are not equal-and-opposite — they are different *atmospheres* of the same world:

- **Dark (canonical):** Aurora over void. Saturated greens, teals, sky-blues and rose pinks bloom against `#030208`. This is the hero state — the app's screenshots, marketing, and TV/Cast receiver should always render dark.
- **Light:** Frosted iOS Air. Same palette, but reduced to gentle blooms behind white glass on a soft blue-grey (`#F2F5F8`). Reads as "daylight aurora."

When in doubt, design dark first, then verify light parity.

---

## 2. Color System

### Aurora Spectrum (the palette)

The palette is scientifically themed on auroral emission lines. Use these names — not raw hex — when discussing color in PRs and reviews.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--aurora-green` (Oxygen) | `#22c983` | `rgba(34,197,94,0.3)` | Primary brand, play actions |
| `--aurora-extra-glow` (Emerald high-altitude) | `#10b981` | `rgba(5,150,105,0.3)` | Hover/active glow on green |
| `--aurora-teal` | `#2dd4bf` | `rgba(20,184,166,0.3)` | Mid-spectrum, progress mid-fill |
| `--aurora-blue` (Sky) | `#0ea5e9` | `rgba(6,182,212,0.2)` | Secondary accent |
| `--aurora-pink` (Nitrogen rose) | `#f43f5e` | `rgba(225,29,72,0.2)` | Rare accent — destructive, "off-spectrum" highlight |

The signature **aurora gradient** is the spectrum traversed in order:

```
linear-gradient(135deg,
  aurora-green 0% → aurora-blue 35% → aurora-extra-glow 70% → aurora-pink 100%)
```

Used on the empty-state hero and the playback progress bar fill (animated). It is the brand mark — use sparingly. Never on buttons, never on icons, never as a background panel.

### Surface & Text

Surfaces are *translucent over the aurora field* — never opaque blocks. Always pair with `backdrop-filter: blur(var(--glass-blur))` (24px) on light, or the dark equivalent. If you need an opaque panel, you are probably building the wrong primitive.

| Role | Dark | Light |
|---|---|---|
| Background | `#030208` | `#F2F5F8` |
| Surface (panels) | `rgba(6,4,18,0.72)` | `rgba(255,255,255,0.6)` |
| Surface variant (nested) | `rgba(14,11,32,0.5)` | `rgba(255,255,255,0.8)` |
| Text primary | `#d8d8e8` | `#1C1C1E` |
| Text secondary | `#8e8ea0` | `#3A3A3C` |
| Text muted | `#55556a` | `#8E8E93` |
| Border | `rgba(34,201,131,0.08)` | `rgba(0,0,0,0.05)` |

**Dark mode is intentionally low-contrast on muted text** (~3:1). This is a design choice — secondary metadata recedes so album art and now-playing dominate. Do not "fix" it with brighter greys; if a label needs more weight, promote it to `text-secondary` or `text-primary`.

### Semantic Color

- `--color-primary` = aurora-green. Filled CTAs, active states, focus rings.
- `--color-error` = aurora-pink (red shift). Destructive only — never warnings, never "different mode" hints.
- `--color-success` = green. Reserved for completed scans/imports.

Never invent new semantic colors. If you need a new role (e.g. "warning"), ask first.

---

## 3. Typography

Two families. No exceptions.

```
--font-display: 'Syne', sans-serif;   /* Editorial, sharp, slightly geometric */
--font-body:    'DM Sans', sans-serif; /* Neutral, readable, tight rhythm */
```

| Use | Family | Weight | Notes |
|---|---|---|---|
| Page titles, hero, modal headers, button labels | Syne | 600–800 | Negative letter-spacing (-0.03 to -0.04em) at large sizes |
| Body, metadata, settings rows | DM Sans | 300–500 | 300 for muted secondary metadata |
| Numerics (timestamps, durations, indices) | DM Sans | 400–500 | `font-variant-numeric: tabular-nums` is required |

### Hierarchy

- **Hero (empty state, page titles):** Syne 700-800, 2.2rem-2.8rem, tight tracking, the aurora gradient text-clip is reserved for the empty-state hero only.
- **Section headers (settings, sidebar group labels):** Uppercase, 0.7-0.9rem, weight 500-700, `letter-spacing: 0.02-0.05em`. This is the secondary brand cue after color.
- **Body:** 0.85-0.95rem. Generous line-height (1.5-1.8) on prose blocks.
- **Metadata (artist, album under a track):** 300 weight, muted color, 0.7-0.85rem. Should *almost disappear* until the row is hovered or active.

Never use Syne for body copy. Never use DM Sans for hero titles. Never bring in a third font.

---

## 4. Glassmorphism

The defining surface treatment. Three rules:

1. **Always blurred.** A glass surface without `backdrop-filter` is just a flat panel — that's a bug. Default blur: `24px`.
2. **Border is a hairline.** Glass edges are `1px` borders at 4-10% alpha. Heavy borders break the illusion.
3. **Never stacked more than 2 deep.** Glass-on-glass-on-glass becomes opaque mud. If you need a third level, switch to `surface-variant` (more opaque) or solid.

```
--glass-bg:     rgba(255,255,255,0.65);  /* light */ | rgba(4,2,14,0.6)  /* dark */
--glass-border: rgba(0,0,0,0.1)          /* light */ | rgba(255,255,255,0.04) /* dark */
--glass-blur:   24px;
--glass-shadow: 0 8px 32px rgba(0,0,0,0.05)  /* light */
              | 0 8px 40px rgba(0,0,0,0.6)    /* dark */
```

The signature **play button** breaks glass conventions on purpose — it is the *only* element that uses the emerald gradient (`--aurora-play-gradient`) plus an emerald glow (`--aurora-play-glow`). Treat it as a sacred element. No other button gets that treatment.

---

## 5. Geometry

### Radius

| Token | Light | Dark | Use |
|---|---|---|---|
| `--radius` | 20px | 14px | Default for cards, modals, large surfaces |
| `--radius-sm` | 12px | 8px | Inputs, list rows, small cards |
| `--radius-lg` | 28px | — | Hero panels, settings layout |
| `--radius-pill` | 9999px | 100px | Progress, sliders, badges |

Light mode uses larger radii — the iOS Air feel. Dark mode tightens up — the void feels sharper.

### Spacing

8-point scale, with a 4-point exception for `xs`:

```
xs:  4px    sm:  8px    md: 16px    lg: 24px    xl: 32px    2xl: 48px
```

Compose, don't invent. If you find yourself reaching for `13px` or `22px`, you're solving the wrong problem.

### Shadow

Three jobs only: **lift** (sm/md/lg), **glow** (`--shadow-glow` — green halo, used on focus and hover of primary surfaces), and **glass** (combined inset + drop, on translucent panels).

Never use shadow as a hard divider — that's what hairline borders are for.

---

## 6. Motion

Motion is *easing-driven*, not duration-driven. Two curves do almost everything:

```
--ease-out:    cubic-bezier(0.16, 1, 0.3, 1);  /* organic, settles softly */
--ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);   /* symmetric, mechanical */
```

| Token | Duration | Curve | Use |
|---|---|---|---|
| `--transition-fast` | 150ms | in-out | Hovers, color shifts, focus rings |
| `--transition-normal` | 250ms | out | Modals, drawers, content swaps |
| `--transition-slow` | 400ms | out | Page transitions, hero entries |

### Signature animations

- **Aurora text shimmer** (empty-state h1): 8s infinite background-position pan. Disabled under `prefers-reduced-motion`.
- **Track transition**: `transform: scale(0.97)` on `:active`, `1.06` on play-button hover. Confidence-inducing micro-motion.
- **Modal entrance**: `scale(0.95) translateY(20px) → 1.0 0` over 300ms ease-out.
- **Drawer**: full-translate slide-in from left, 300ms.

Always honor `prefers-reduced-motion`. The aurora text animation is already gated; new infinite/looping animations must be too.

---

## 7. Component System

### Buttons (canonical — see also AGENTS.md §Button System)

Compose `.btn` + variant + size:

| Class | Purpose |
|---|---|
| `.btn` | Base — Syne 600, glass surface, 8/16 padding |
| `.btn-primary` | Filled emerald. The single "go" action. |
| `.btn-danger` | Outlined rose. Confirmable destructive. |
| `.btn-danger-fill` | Filled rose. Final-step destructive. |
| `.btn-ghost` | Glass/neutral. Default for tertiary actions. |
| `.btn-tab` | Sub-tab toggle. `.active` swaps to filled emerald. |
| `.btn-dashed` | Full-width add/create. |
| `.btn-icon` | Icon-only. Combine with `.btn-danger` for destructive icon. |
| `.btn-lg` / `.btn-sm` | Size modifiers. |

**Never write inline Tailwind button strings.** If a new button shape is needed, add it as a variant class.

### Player controls

Two tiers:

- **Secondary (`.player-control-btn`):** 40px circle, glass. Dark-on-light glass in light mode; white-on-dark in dark. Used for prev/next/shuffle/repeat.
- **Primary (`.play-btn-main`):** 56px circle, emerald gradient, glow. Same in both modes — this is the brand anchor on every screen.

Mobile: 48px / 64px respectively. Touch targets must hit ≥44px.

### Album art

Always `border-radius: var(--radius)`, always `1px` glass border, always a soft drop shadow. Never raw square. Aspect ratio is locked 1:1 (`object-fit: cover`).

`useDominantColor(tracks)` extracts the dominant color from current art and seeds page hero gradients. This is how album art pulls the surrounding chrome into its mood — keep it. Never hard-code page-level color.

### Lists & rows

Rows are *quiet by default*: transparent border, muted text. Hover lifts opacity (`rgba(255,255,255,0.03)` dark, `rgba(255,255,255,0.4)` light) and a subtle border. Active state shifts text to `--color-primary` and bumps weight to 600. **No backgrounds on rest state** — the playlist sidebar is one of the few places where the absence of chrome is the design.

### Progress & sliders

3px rail, hover expands to 5px. Fill uses the aurora gradient (the one place besides the empty-state hero). Thumb is a 11px white dot, scale-0 by default, scale-1 on hover. Tabular-nums on the time labels.

### Modals & drawers

- **Modal:** centered, max-width 500px (or 1200px for the Discord-style settings layout), `slide-up` 300ms. Backdrop is blurred at 8px.
- **Drawer:** left side, max-width 380px, `slide-in-left` 300ms. Used for mobile nav and side panels.
- **Settings:** full-screen layout with a 260px sidebar and a centered 740px content column. On mobile the sidebar collapses to top tabs.

Backdrop click and Escape both dismiss. Always.

---

## 8. Layout Patterns

### Grids

`.album-grid` is the canonical responsive cover grid:

```
<640:  2 col    <768:  3 col    <1024: 4 col    <1280: 5 col    ≥1280: 6 col
gap:   1rem  →  1.5rem at md
```

Use it everywhere covers tile (LibraryHome, ArtistDetail, GenreDetail). Don't invent new grid breakpoints.

### Page container

`.page-container` standardizes detail-view padding: `1rem` mobile, `2rem` tablet, `3rem` desktop. Scrollable, flex child.

### Hero pattern

For ArtistDetail, GenreDetail, AlbumDetail:

1. `FadedHeroImage` — full-bleed art with a vertical mask fade to background.
2. Title in Syne 700+, large, negative tracking.
3. Metadata row in DM Sans 300, muted, uppercase tags.
4. Primary action (Play) using `.btn-primary` or the emerald play disc.

Do not stack two hero images. If a sub-page needs its own hero, it gets its own route.

---

## 9. Iconography

`lucide-react` only. Reasons:

- Consistent stroke weight (1.5px) across the app.
- Tree-shakeable — no bundling all icons.
- Visual language is geometric, slightly editorial — matches Syne.

Inline SVGs are allowed *only* when no Lucide equivalent exists (e.g. brand logos, the custom waveform). Don't ship Material icons, Font Awesome, or Heroicons.

Icon sizes follow text sizes: `0.85rem` text → `16px` icon. In buttons, icons inherit `currentColor`.

---

## 10. Mobile & Touch

Mobile is not a degraded desktop — it has explicit affordances:

- **Touch targets ≥44px.** `.player-control-btn` becomes 48px, `.play-btn-main` 64px.
- **Volume slider, keyboard hints hidden.** Volume is a system control on touch; keyboard hints are noise.
- **Bottom tabs + mini-player + full-screen NowPlaying** is the canonical mobile shell. Sidebar drawer for nav.
- **Safe area insets are mandatory** on any pinned-edge UI. Use `.safe-area-top`, `.safe-area-bottom`, or `env(safe-area-inset-*)` directly. This includes the Cast receiver overlay (TV-safe).
- **Swipe gestures** via `useSwipe(ref, ...)`. Prefer it to ad-hoc touch handlers.

Settings on mobile drops the sidebar entirely and switches to top tabs (`.settings-mobile-tabs`).

---

## 11. Cast / Receiver UI

The Chromecast custom receiver (`public/receiver.html`) is *Aurora dark, always*. It must:

- Render a blurred album-art background (heavy blur, low opacity).
- Show now-playing metadata in Syne 700+ at TV-readable sizes (≥3rem title).
- Render a glass `Up Next` queue panel — same glass tokens as the app.
- Honor TV-safe margins (5% inset minimum).
- Use the emerald play disc for the active state chip.

The receiver is the brand on a 65" screen — treat it as a hero surface, not a debug overlay.

---

## 12. Accessibility

- **Focus visible** is a hairline emerald outline (`outline: 1px solid rgba(34,201,131,0.4)`) with `outline-offset: 2px`. Never remove it.
- **Selection color** is emerald at 25% alpha. Don't override per-component.
- **Contrast:** Primary text passes WCAG AA on both modes. Muted text intentionally does not — see §2 caveat. If you need to communicate critical info, don't use muted.
- **`prefers-reduced-motion`** disables looping animations (aurora text, scan indicators). New looping motion must be gated.
- **ARIA tabs** in settings nav are mandatory — `role="tab"`, `aria-selected`, `role="tabpanel"`. Established pattern, don't break it.
- **Keyboard** controls: Space (play/pause), arrows (seek/volume), `?` (help) are global. Don't shadow them in modals without restoring on close.

---

## 13. Authoring Rules

A short list of things that come up in PR review:

1. **Never use raw hex in a component.** Pull from CSS variables. If a needed color doesn't exist, propose a token, don't inline.
2. **Never write inline Tailwind button strings.** Use `.btn` variants.
3. **Never opaque-fill a glass surface.** If you need opacity, use `surface-variant`.
4. **Never invent a third font, a fourth radius token, a new spacing value.** Compose existing tokens.
5. **Never use the aurora gradient outside the two sanctioned places** (progress fill, empty-state hero text). It is a brand mark.
6. **Never break the play-disc.** Same emerald gradient + glow on every screen, every mode.
7. **Always test light mode parity** — at minimum, modals, hero gradients, and any new glass surfaces.
8. **Always blur a glass surface.** A non-blurred glass panel is broken.
9. **Always honor reduced-motion** on new animations.
10. **Always use `lucide-react`** for new iconography.

---

## 14. Anti-patterns (seen and rejected)

- Inline gradients on buttons → flattens the brand mark, makes everything a CTA. Buttons get solid fills only.
- Heavier glass borders (>1px or >15% alpha) → breaks the iOS Air illusion, looks like a Material card.
- Material elevation shadows (multiple offset dropshadows) → not the language. We have one shadow per element.
- "Toast"-bright greens or saturated UI accents on small elements → kills the editorial feel. The aurora is in the *background*, not in the toolbar.
- Typing the hex `#22c983` into a component → use `var(--color-primary)`.
- Three nested glass panels → switch the innermost to `surface-variant` or solid.
- Shadow-as-divider → use a hairline border on `--glass-border`.

---

## 15. References

- Tokens: `src/index.css` (`:root`, `.dark`)
- Theme objects (legacy, still consumed by some components): `src/theme.tsx`
- Button system reference: `AGENTS.md` §Button System
- Tailwind config: `tailwind.config.js` (intentionally minimal — most styling is via CSS vars and global classes)
- Live-color extraction: `src/hooks/useDominantColor.ts`
- Cast receiver: `public/receiver.html`
