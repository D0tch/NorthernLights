# Changelog

## [v1.0.0-rc.3] - 2026-05-19

### Library
- **Facet Filters & Query Builder**: Artists and Albums now have sort, facet, and advanced query filtering with a visual query builder modal supporting AND/OR condition groups
- **Filter API**: `POST /api/filter/artists` and `/api/filter/albums` with validated SQL field references and ILIKE queries
- **GIN Trigram Indexes**: `artists(name, genres, community_tags, area)` and `albums(title, artist_name, tags)` for index-backed wildcard text search at scale
- **Merged Artist Redirects**: Merged rows preserved as redirect pointers (`merged_into` UUID column) instead of deletion, preventing re-creation on library refresh
- **Manual Artist Merge**: New "Manual merge" section in Artist Entities to merge any two artists by name with side-by-side preview cards and audit trail in `artist_duplicate_reviews`
- **Album Merge Conflict Handling**: `UNIQUE(title, artist_name)` violations now fold tracks into the survivor album instead of failing

### UI
- **SoftAurora WebGL Backdrop**: Animated aurora bands on Login and Invite Register pages via `ogl` renderer
- **Reduced Motion Toggle**: Appearance settings now offers a persistent reduced-motion preference independent of OS-level `prefers-reduced-motion`
- **Settings Modal Redesign**: Grouped nav (User/App/Server/Admin), search with auto-switch, ESC close, body scroll lock, compact layout via matchMedia
- **Settings Tabs Redesign**: Account (profile hero, password form, deletion flow), Library (coverage stats, folder rows, analysis progress), Artist Entities (overview, guide cards, review queue, manual merge), Live Music (hero toggle, overview grid, collapsible location, auto-subscribe strip)
- **Modal Accessibility**: ConfirmModal/PromptModal now have focus traps, `aria-labelledby`/`aria-describedby`, `role="dialog"`, and restore-focus-on-unmount. PromptModal supports `inputType`, `autoComplete`, `confirmLabel`
- **~2500 lines of new CSS**: Filter rack, settings panels, switch toggles, merge preview cards, live music panels, unified responsive grids

## [v1.0.0-rc.2] - 2026-05-19

### Security
- **Scoped Token Auth**: Separate `mediaAccessToken` and `sseAccessToken` JWTs (scope-limited, 7-day expiry) for HLS/Cast URLs and SSE streams — account JWT never exposed in URLs
- **Password Policy**: Minimum 12 characters enforced across all creation surfaces (register, setup, admin create, password change)
- **DB Recovery Token**: `AURORA_DB_RECOVERY_TOKEN` env var for unauthenticated database maintenance when auth cannot be verified
- **SSE Token Encoding**: All EventSource connections use `encodeURIComponent` for token parameters

### UI
- **PlayerShell**: Desktop player redesigned as a compositional floating-pill / full-width-docked slab with animated transition between modes
  - Top-edge chevron toggle (`bend`) for float ↔ dock switching
  - Signal chain chip: hover-expanding pill showing quality → codec → bitrate
  - Ticker title in float mode for long track names
  - `usePlayerPlacement` hook for responsive placement
  - 660 lines of new CSS: shell, bar-row grid, transport, volume, chain, waveform

### Cast Reliability
- Session preservation: `SESSION_ENDED` with active rejoin now stores session ID and calls `requestSessionById` instead of dropping
- Stale hydration cancellation: monotonically increasing `rejoinHydrationRunId` cancels outdated rejoin loops
- Stale media status discard: refreshes discarded when session ID changes between call and callback
- Remote-player disconnect during rejoin preserved as recovering state

## [v1.0.0-rc.1] - 2026-04-30

### Core Architecture
- Client-server music player with React + Express + PostgreSQL
- JWT authentication with per-user libraries, playlists, and recommendations
- PWA support with Workbox service worker and offline-capable caching

### Audio & Playback
- Gapless local file playback via FFmpeg-backed HLS streaming
- Google Cast (Chromecast) integration with custom CAF receiver UI
- Multi-output device selection (system default, specific speakers)
- Media Session API controls for background playback
- Prebuffering and next-track prewarm for smooth transitions

### AI Playlist Generation (Hub)
- Library-relative LLM concept compiler that interprets concepts against actual local library
- Explicit candidate pools: core, adjacent, root, acoustic, discovery, bridge
- Recovery ladder: exact → adjacent → same-root → acoustic → bridge → discovery
- Per-playlist diagnostics: pool sizes, relaxation level, diversity metrics
- Configurable tuning: Genre Cohesion, Playlist Diversity, Discovery Bias, Artist Spread

### Recommendation Engine
- 21-dimensional vector similarity: 8D acoustic + 1280D Discogs-EffNet embeddings
- pgvector HNSW indexes for fast similarity search
- Library profile layer: analyzed coverage, artist entropy, per-genre health
- Hop-cost genre math via MusicBrainz hierarchical taxonomy (~2,000 genres)
- 3-step genre pipeline: SQL match → LLM batch → KNN fallback

### Artist Management
- Normalized artist keys for variant resolution (Tiësto/Tiesto, N'to/NTO)
- Duplicate detection with manual merge/dismiss workflow
- Compound credit splitting (preserves "Nick & Jay", splits "A, B & C")
- Collaboration album surfacing (50%+ track credit = co-primary on both artist pages)

### Smart Playlists
- Daylist: time-of-day aware with bucket-based freshness
- On Repeat: listening pattern analysis
- Repeat Rewind: past favorites
- Time Capsules: seasonal/yearly rewind
- SmartHub persistence with transaction safety and advisory locking

### UI/UX
- Premium "Matte Glass" dark theme with responsive design
- Hub with crossfade animations and crossfaded tile transitions
- Queue save-as-playlist functionality
- Horizontal scroll rails with arrow navigation
- Virtualized library views for large collections
- Shared context menu primitives for mobile/desktop
- Performance-optimized: lazy routes, LRU-cached dominant colors, optimized waveform rendering

### Deployment
- One-line install script for Ubuntu/Debian
- PM2 or systemd service management
- Reverse proxy (Nginx) configuration for HTTPS
- Production guide in `docs/production_guide.md`

### Documentation
- `docs/architecture_overview.md` - System architecture diagram and component breakdown
- `docs/music_recommendation_engine.md` - Engine details and vector schema
- `docs/production_guide.md` - Deployment, environment config, troubleshooting
- `docs/API.md` - API endpoints reference