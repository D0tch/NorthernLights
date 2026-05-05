# Product

## Register

product

## Users

Aurora is built for people who own their music library and want it to feel alive again.

The canonical user owns thousands to hundreds of thousands of local tracks across mixed formats, runs or understands a home server, and listens across desktop, phone, Chromecast, speakers, and TV. They may have tried Plexamp, Navidrome, Jellyfin, Subsonic-style apps, or Roon, but want stronger library-native discovery and a more premium daily listening surface.

Secondary users are household members or invited listeners. They should get a clean music app, not an admin console. They benefit from the same playback, queue, Cast, and discovery work, but the product is not optimized around multi-tenant operations.

Aurora is not for users who primarily want a cloud streaming catalog, social music feeds, DJ tooling, generic media-server browsing, native mobile apps, or deep audiophile DSP.

## Product Purpose

Aurora is a self-hosted music player for owned files. It scans and enriches a local library, streams it reliably through browser and Cast-compatible HLS, and uses local metadata, audio analysis, genre intelligence, and optional AI to make the user's own collection feel endless.

The product exists to combine ownership with flow. Streaming apps made listening feel contextual and immediate; self-hosted music apps preserved ownership but often shipped file-browser UX. Aurora should make a large owned library feel as easy to start, continue, and rediscover as a premium streaming app, without giving up control of files or data.

Success looks like this:

- The Hub becomes the natural starting point for listening, not just a library index.
- The user can move between desktop, mobile, Chromecast, and TV without losing playback control.
- Queue, Cast, and preloading behavior feel stable enough that the user stops thinking about transport.
- Recommendations only surface music the user owns, unless an enrichment surface clearly says otherwise.
- The interface feels intentionally designed, not like a generic self-hosted admin tool.

## Brand Personality

Aurora is premium, calm, and luminous.

The product voice is factual and quiet. It should feel confident without hype, technical without leaking implementation detail, and polished without becoming decorative. Copy should use direct music language: track, album, artist, genre, queue, playlist, Hub, Cast, receiver.

The brand metaphor is the Northern Lights: dark space, soft glow, controlled color, and motion that feels atmospheric rather than flashy. Album art and playback state should carry emotional weight. Chrome should support listening, not compete with it.

Reference traits:

- Apple Music for editorial hierarchy and confidence.
- iOS Air glass for frosted light-mode material.
- Roon and Sonos S2 for premium playback trust.
- High-end TV music UIs for the Cast receiver.

## Anti-references

Aurora must not look or behave like:

- A Spotify clone with flat green buttons and generic streaming-app layout.
- A Plex, Jellyfin, or file-server admin panel with media thumbnails attached.
- A Material UI dashboard with dense cards, hard dividers, and default controls.
- A neon cyberpunk interface where glow becomes noise.
- A theming playground where every color, font, and density choice is exposed.
- A default Google Cast receiver or a Cast-only parallel player.
- A stack of duplicate playback surfaces, mini players, status banners, and modals that all describe the same session.

## Design Principles

### 1. The Library Is The Canon

Every recommendation, search result, queue action, and Hub playlist starts from music the user owns. External providers enrich the owned library; they do not redefine it.

### 2. Listening Flow Beats File Management

The product should always make it easy to start or continue a session. Browsing artists and albums matters, but the primary job is listening, not catalog administration.

### 3. Playback Has One Owner Per Surface

Desktop player controls own desktop playback. The mobile mini player and mobile now-playing screen own mobile playback. The Cast receiver owns TV playback. Cast state is reflected inside those existing surfaces, never by adding a second mini player, a Cast control modal, or a persistent Cast status banner.

### 4. Reliability Is Product Design

HLS preloading, Cast reconnection, stale-session recovery, queue sync, and receiver logging are user experience work. Failures should be visible, recoverable, and quiet: global toasts for actionable issues, animated icon state for connecting or recovering, durable logs for diagnosis.

### 5. Premium Feel Is A Feature

A feature that works but feels generic is not done. Typography, spacing, motion, empty states, loading states, and Cast receiver presentation are part of the shipped behavior.

### 6. Fast Enough To Feel Free

Playback transitions, queue actions, Hub generation, and Cast commands should feel immediate. Background work should be prewarmed, cached, streamed, or deferred so the listening flow is not interrupted.

### 7. Ownership Stays Visible

No telemetry by default. No required cloud account for core use. Open standards and inspectable local services are preferred over proprietary black boxes.

## Accessibility & Inclusion

Aurora targets accessible product UI, not decorative showpieces. Primary text and controls should meet WCAG AA expectations. Critical state must never rely on color alone. Keyboard navigation, focus-visible rings, screen-reader labels, reduced motion handling, and tabular numerics are required across playback and settings surfaces.

Mobile touch targets should be at least 44px, with safe-area handling on pinned controls. TV and Cast UI must remain legible at living-room distance and lightweight enough for older Chromecast hardware.

Reduced motion should preserve comprehension. If motion communicates connecting, buffering, loading, or playback state, provide a non-motion text or state equivalent.

## Voice And Copy

- No exclamation marks.
- No AI magic language. Say what the system is doing.
- Prefer lowercase operational states: scanning, analyzing, connecting, recovering.
- Avoid blame. Use "No tracks found" instead of "You have not added tracks".
- Keep technical terms out of user-facing copy unless the user chose an advanced setting.
- Use direct action labels: Play, Pause, Retry, Stop Cast, Add to Queue, Play Next.

## Non-goals

- Cloud streaming catalog integrations as a primary library source.
- Video, podcasts, audiobooks, or generic media-server scope.
- Native iOS or Android apps while the PWA can carry the experience.
- Generic plugin systems that fragment product quality.
- Full DJ tooling, room correction, upsampling, or audiophile DSP suites.
- Social feeds, public profiles, telemetry, analytics, or usage tracking.
- User-supplied skins or arbitrary visual theming.

## Quality Bar

A feature is not shipped until it works across the relevant playback routes, preserves the existing design system, handles loading and error states, respects reduced motion and keyboard access, and does not introduce a parallel UI pattern for an existing job.

For playback-related work, browser local playback, HLS quality behavior, Cast sender control, and custom receiver behavior all count as part of the same feature.
