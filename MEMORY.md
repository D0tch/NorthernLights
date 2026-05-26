# Project Memory / Changelog

## [2026-05-26] V1.0.0-rc.4: OpenSubsonic API, View Transitions, Hero Skeletons, Search Polish

- **OpenSubsonic `/rest` Surface**: Full Subsonic-compatible API for third-party clients. API-key-only authentication (rejects u/p and token/salt with proper error codes). Covers library browsing, search (2/3), playlists CRUD, stream/download/HLS media, cover art, star/rate/scrobble, and empty compatibility stubs. Keys are SHA-256–hashed with prefix-based lookup and last-used-at tracking.
- **Subsonic Key Management**: CRUD endpoints under `/api/auth/subsonic-api-keys` with rate limiting. Frontend Account settings section for creating, copying (one-time reveal), and revoking keys.
- **Single-Playlist Fetch**: `GET /api/playlists/:id` avoids N+1 by fetching one playlist with tracks in two queries. Dashboard detail view uses `fetchPlaylistFromServer(id)` as the primary path, falls back to bulk refresh on 404.
- **View-Transition Morphing**: `withViewTransition` wrapper using `document.startViewTransition` + `flushSync` for SPA page morphing. Per-entity `view-transition-name` on album covers, artist avatars, and playlist mosaic grids so the browser animates the element between list and detail views.
- **Hero State Skeletons**: Typed `AlbumHeroState`, `ArtistHeroState`, `PlaylistHeroState` passed via React Router `state` so detail pages render title, art, and metadata instantly before store data arrives. Skeletons use hero data when available and fall back to pulse placeholders.
- **Route Prefetch**: Centralised `routePrefetch.ts` exports lazy components and deduplicated prefetch functions triggered on `pointerenter`, `pointerdown`, and `focus` for album/artist/playlist cards, Hub tiles, and search result rows.
- **GlobalSearch Redesign**: Inline Tailwind replaced with named `global-search-*` CSS classes. Desktop pill expands with `scaleX` animation; mobile opens a full-screen overlay with separate header, field, and results zones. Close animates out with a 180ms reverse before unmounting. Search input uses `type="search"` and `autoComplete="off"`.
- **Mobile Now Playing Sheet**: Correct exit animation by deferring unmount 340ms past the CSS `slide-down` duration. Uses `data-state="open"|"closing"` on the shell element for enter/exit keyframes. Removed the `animate-slide-up` class in favour of state-driven animations.
- **Context Menu Cleanup**: Removed unused `showMobileHandle` prop and the drag-handle strip from mobile bottom sheets.
- **Account API Key Styles**: New CSS for key reveal banner, revoked provider opacity, and create button alignment in settings.
- **Trigram Indexes**: GIN `gin_trgm_ops` on `tracks(title, artist, album)` for fast ILIKE Subsonic search.

## [2026-05-19] V1.0.0-rc.3: Library Filters, Artist Merge Redirects, Settings Redesign, Accessibility

- **Filter Bar Spacing**: Wrapped `FilterBar` in a `.filter-zone` container with consistent bottom margin (24px desktop, 18px mobile, 28px touch-coarse) to fix layout compression.

- **Library Filter System**: Facet-based filtering for Artists and Albums with sort options, query builder modal (AND/OR condition groups against server-side SQL columns), and mobile filter overlay. New `POST /api/filter/artists` and `/api/filter/albums` endpoints with validated ILIKE queries. GIN trigram indexes on artists(name, genres, community_tags, area) and albums(title, artist_name, tags) for index-backed wildcard text search.
- **Merged Artist Redirects**: Merged-away artist rows are now preserved with a `merged_into` UUID pointing to the canonical row instead of being deleted. This prevents library refreshes from recreating credit strings as fresh duplicates. `getOrCreateArtist`, `getArtistById`, `getAllArtists`, and the filter API all chase redirect chains. `purgeOrphanedEntities` keeps merge targets alive. Album merge now handles `UNIQUE(title, artist_name)` conflicts by folding tracks into the survivor before deleting the duplicate.
- **Manual Artist Merge**: New UI in Artist Entities tab for merging any two artists by name (e.g. "DJ Tiësto" → "Tiësto") with side-by-side preview cards showing track/album counts and MBID. Backend endpoint `POST /api/library/artists/manual-merge` writes the merge to `artist_duplicate_reviews` for auditability. ConfirmModal extended with `body` (ReactNode), `confirmTone` ('primary' | 'danger'), and wider layout for merge previews.
- **SoftAurora WebGL Backdrop**: Replaced static CSS `.aurora-background` on Login and InviteRegister pages with an OGL-based `SoftAurora` component rendering animated aurora bands. Adds `ogl` dependency.
- **Reduced Motion Preference**: User-toggled reduced motion in Appearance settings persists to Zustand store and sets `html.reduced-motion` class that disables all animations/transitions. Also honors OS-level `prefers-reduced-motion`.
- **Settings Modal Redesign**: Overhauled layout with matchMedia-based compact detection, grouped navigation (User/App/Server/Admin), search with auto-switch, ESC close, body scroll lock, and empty-state for no matching settings. Desktop sidebar and mobile pill nav share icon+label pattern.
- **Settings Tabs Redesign**: AccountTab — profile hero, structured change-password form, ListenBrainz connect/disconnect, account deletion flow. LibraryTab — coverage stats bar, structured folder rows with actions, audio analysis progress, ML models grid. ArtistEntitiesTab — overview stats, guide cards, review queue, manual merge section with datalist-backed artist search. LiveMusicTab — hero toggle with overview grid, collapsible location editor, auto-subscribe strip inline in subscriptions panel.
- **Modal Accessibility**: ConfirmModal and PromptModal now use `useId` for `aria-labelledby`/`aria-describedby`, `role="dialog"` + `aria-modal`, Tab focus traps cycling focusable elements, and restore-focus-on-unmount. PromptModal gains `inputType`, `autoComplete`, `confirmLabel` props.
- **CSS System**: Added ~2500 lines of new styles for library filter rack (aurora-themed facet buttons, chip strips, query builder panels), settings modal ambient gradient, account profile hero, switch toggles, folder rows, progress bars, live music panels, artist merge preview cards, manual merge grid, auto-subscribe strip, and unified album/artist/genre responsive grid breakpoints. `reduced-motion` class on `<html>` kills all animations.

## [2026-05-19] V1.0.0-rc.2: Scoped Tokens, PlayerShell, Cast Reliability, Security Hardening

- **Scoped Token Auth System**: Introduced `mediaAccessToken` and `sseAccessToken` — separate JWTs with limited scope (`media` | `sse`) and 7-day expiry. Safe to embed in HLS/art/Cast URLs and EventSource query strings without exposing the full account JWT. Login, register, and session restore now persist all three tokens.
- **PlayerShell Redesign**: Floating-pill / full-width-dock desktop player bar with a top-edge chevron `bend` toggle, signal chain chip (quality → codec → bitrate), ticker title in float mode, and responsive placement via `usePlayerPlacement`. 660 lines of new CSS for the shell, bar-row grid, transport, volume, chain, and waveform integration.
- **Cast Session Preservation**: `SESSION_ENDED` with `preserveSessionOnNextEnd` now stores the session ID and re-joins via `requestSessionById` instead of dropping the connection. Stale rejoin/hydration loops are cancelled by a monotonically increasing `rejoinHydrationRunId`. Media status refreshes discard stale callbacks when the session ID changes between call and callback. Remote-player disconnect during an active rejoin is preserved rather than resetting to NOT_CONNECTED.
- **Password Minimum 12 Characters**: All password creation surfaces (SetupWizard, AdminPanel, InviteRegister, AccountTab) now enforce a 12-character minimum, up from 5.
- **Database Recovery Token**: `DatabaseControl` now accepts an `X-Aurora-Recovery-Token` header (set via `AURORA_DB_RECOVERY_TOKEN` env var) for unauthenticated DB maintenance when the database is down and normal admin login cannot be verified.
- **Security: SSE Token Encoding**: All EventSource connections now `encodeURIComponent` the token parameter to prevent special-character breakage. SetupWizard, LibraryTab, and DatabaseTab use the dedicated `sseAccessToken`.
- **Backend: New `scopedToken.service.ts`** with `generateScopedToken` / `verifyScopedToken` for `media` and `sse` scopes. New `requireScopedAuth` middleware accepts `?token=` on media + SSE routes. Auth routes return `{ token, mediaToken, sseToken }` on login/register.

## [2026-05-05] V1.0.0-rc.1: Cast SDK Design Compliance Pass
- **Official Sender Cast Launcher**: Replaced custom lucide Cast action buttons with a shared `CastButton` component backed by `<google-cast-launcher>`, so the Cast SDK owns discovery, device selection, route switching, and connected-state behavior. Desktop player controls now show the connected device name and a first-time Cast-ready coach mark.
- **Mobile Cast Controls**: Mobile Now Playing and Mini Player now expose the same Cast launcher affordance, and Mobile Now Playing includes a Cast volume slider wired through the existing store/CastManager volume path.
- **Receiver State Affordances**: The Aurora receiver overlay now displays explicit Loading, Buffering, Seeking, Paused, and Idle state feedback, animates the status/progress treatment for transient states, and dims after long idle/paused periods while logging the dim transition to Cast diagnostics.
- **Queue Safety UX**: Play Queue now supports Clear with undo, per-track removal undo, and a direct desktop Stop action while casting. Queue undo restores the previous snapshot and rehydrates Cast playback if the queue is restored during an active Cast session.
- **Queue & Autoplay Compliance**: User-initiated Play Next and Add to Queue now emit visible undoable queue confirmations without affecting internal Infinity/prewarm queue additions. Automatic queue advance shows a compact `Up next` sender notification, while queue context remains available through the existing play queue/sidebar surfaces.
- **Visible Cast Health Surface**: `CastManager` now exposes sender health states for hydration, rejoin, stale transport recovery, recovery success, warnings, and reconnect failures. `CastHealthToasts` routes recovered/warning/error states through the global toast system, while connecting/rejoining/recovering states are reflected as an animated spinner in the existing Cast launcher slot.
- **User-Actionable Cast Recovery**: Cast warning/error banners now include a Retry action. The retry path attempts silent reconciliation first and opens the normal Cast session flow only when the sender cannot recover the stored session silently. The banner remains mounted outside the playback footer so app-reopen rejoin failures are visible even with an empty local queue.
- **Sender Controller Consolidation**: Cast sender controls are consolidated into the existing desktop `PlayerControls`/`ProgressBar`, `MobileMiniPlayer`, and `MobileNowPlaying` surfaces. The separate Cast mini player and Cast-only expanded controller modal were removed to avoid duplicate playback chrome; Cast state still shows device context, direct Stop on desktop, mobile Cast launch, and Cast volume in Mobile Now Playing.
- **Receiver UI Compliance**: Hardened the custom receiver state model with explicit app-loading, content-loading, delayed buffering, seeking, paused, idle, playback, and error affordances. Paused playback now fades non-essential UI after 5 seconds, idle state rotates low-frequency tips and burn-in offsets, idle receivers stop after 5 minutes, and paused receivers stop after 20 minutes while logging the last position.
- **Media Session / Lock Screen Compliance**: Cast state now feeds browser Media Session metadata. Remote Cast hydration, media-status changes, and receiver queue auto-advance update sender-side title, artist, album, artwork, duration, position, and playback state so Android/Chrome PWA notifications and lock-screen controls match the receiver when supported. Seek actions now use routed Cast time/duration while casting.
- **Cast Reliability Diagnostics Compliance**: Added checklist-specific Cast log markers for `cast-button-state`, receiver state transitions, receiver idle/paused timeouts, and `stale-transport-recovered`. The Playback debug toggle now also enables verbose Cast receiver diagnostics, that preference is sent through Cast `customData`, and `/api/cast/log` redacts JWTs, query tokens, and Bearer headers before writing to `logs/cast-receiver.log`.
- **Cast Verification Close-Out**: Added the final Cast manual verification matrix to `docs/cast-design-checklist.md` and introduced `npm run verify:cast`. The verifier audits `logs/cast-receiver.log` for all required compliance markers and fails if unredacted query tokens, Bearer tokens, or JWT-shaped values appear in diagnostics.

## [2026-04-23] V1.0.0-beta.3: Library-Relative LLM Playlist Architecture & Quality Pass
- **Library-Relative Hub Compiler**: Added `server/services/llmConceptCompiler.service.ts` so Hub concepts are compiled against the actual local library instead of being interpreted as genre-absolute requests. The compiler resolves MusicBrainz paths, picks a primary path using specificity plus local health, expands into adjacent locally-supported paths, builds bridge vectors toward the library mainstream, sanitizes conflicts against banned genres, and scores concept quality before playlist generation.
- **Named Multi-Pool Candidate System**: Replaced the older implicit Pool A / Pool B logic with explicit `core`, `adjacent`, `root`, `acoustic`, `discovery`, and `bridge` pools. Candidate generation is now library-relative, deduped across pools before ranking, and traced via compact per-playlist diagnostics.
- **Explicit Recovery Ladder**: Hub generation now enables pools in a deterministic sequence (`exact-path` → `adjacent-path` → `same-root` → `acoustic-similarity` → `mood-bridge` → `discovery-backfill`) and records the highest level reached per playlist. Genre anchoring is kept only while the concept is still in genre-grounded recovery.
- **Constrained Diversity Selector**: Replaced the old fit-first selection behavior with a constrained optimizer that applies song deduplication, artist caps, album penalties, genre-root penalties, acoustic-cluster penalties, novelty boosts, pool-balance targets, and diversity scoring. Long playlists now get an extra quality floor pass when artist spread or diversity lands too low.
- **PlaybackTab Tuning Redesign**: The LLM settings surface now maps to the current engine model. Basic controls are `Number of Playlists`, `Tracks per Playlist`, `Genre Cohesion`, `Playlist Diversity`, `Discovery Bias`, `Artist Spread`, and `Banned Genre Handling`, with `Recovery Strength`, `Adjacent Reach`, and `Genre Penalty Curve` in Advanced. Legacy `genreBlendWeight` values still load as `llmGenreCohesion` until resaved.
- **Diagnostics & Failure Recovery**: Added a compact per-playlist diagnostic block plus filtered-pool drop diagnostics. Remaining failure modes are now logged with pool sizes after veto/exclusion filters, post-filter viability, rerank fallbacks, and direct admissible-set recovery.
- **Quality / Sanitization Pass**: Broad generic concepts can now be rejected for regeneration before expensive candidate fetches, contradictory target/banned combinations are sanitized, veto-aware viability prevents false recovery success, multi-root concepts no longer lose valid roots during rerank, and healthy admissible pools no longer get dropped because of anchor-heavy rerank collapse.

## [2026-04-21] V1.0.0-beta.3: Chromecast Queue Sync, HLS Stabilization & Receiver UI
- **Custom Receiver HLS Stabilization**: Fixed Chromecast `905/104` failures by hardening the HLS presentation end-to-end. Sender now loads queues through a normal `chrome.cast.media.LoadRequest` with `queueData` instead of misusing `QueueLoadRequest` through `CastSession.loadMedia()`. This resolved CAF receiver errors such as `Media or QueueData is mandatory` and `INVALID_REQUEST INVALID_PARAMS`.
- **Master / Media Playlist Split**: `/api/stream/:trackId/playlist.m3u8` is now a proper master playlist with `#EXT-X-STREAM-INF`, while the actual media playlist moved to `/api/stream/:trackId/media.m3u8`. This gave Cast explicit queue/media metadata and eliminated the earlier “play 10 seconds, then buffer” behavior caused by serving a one-segment in-progress media playlist too early.
- **HLS Session Readiness & Spec Guardrails**: HLS sessions now wait for at least 2 segments, or 1 segment plus `#EXT-X-ENDLIST`, before being considered ready. Segment MIME is normalized to `video/mp2t`, FFmpeg MPEG-TS HLS output is validated server-side, and segment routes resolve only exact `(trackId, quality, codec)` sessions.
- **Persistent Cast / HLS Diagnostics**: Added `server/services/debugLogger.service.ts` plus `/api/cast/log` so receiver events, server playlist events, FFmpeg stderr, first-segment `ffprobe` output, and exact session traces are written to `logs/hls-server.log`, `logs/cast-receiver.log`, and `logs/hls-sessions/*.log`.
- **Runtime Streaming Quality Honor**: Browser HLS and Chromecast now rewrite HLS URLs at playback time according to the latest Playback settings. Changing `Streaming Quality` in the UI affects newly started local playback and cast playback immediately, instead of requiring the queue to be rebuilt from original URLs.
- **Dynamic Cast Queue Mutation**: Added `queueEntryId` to `TrackInfo` plus `src/utils/queue.ts` helpers to give each sender-side queue entry a stable identity. `CastManager` now mirrors local queue actions onto the active Cast queue: `Play Next`, append, remove, reorder, repeat-mode sync, and jump-to-item all operate through sender queue APIs instead of reloading the whole queue and interrupting playback.
- **Queue-Aware Auto-Cast**: Connecting to a Cast device while playing locally now auto-loads the full current queue, starts at the matching track index, and seeks to the local playback timestamp. This preserves context better than the earlier single-track cast handoff.
- **Premium Receiver UI Refresh**: Rebuilt `public/receiver.html` into an Aurora-branded TV interface that stays faithful to the app’s existing dark aurora palette, oxygen-green / teal / rose accents, Syne + DM Sans typography, and glass aesthetic. The receiver now shows blurred artwork background, large now-playing metadata, live progress, state chips, and an `Up Next` queue panel while keeping CAF playback behavior and debug instrumentation intact.
- **Next-Track HLS Prewarm**: Added `POST /api/stream/:trackId/prewarm` and `src/utils/PreloadManager.ts`. The frontend now prewarms the next queued HLS session after playback starts, queue mutations, cast-state changes, Infinity Mode additions, and streaming-quality changes. The backend prewarm route reuses the same HLS session readiness logic as playback, so the next track’s FFmpeg session and first segments are prepared before transition without downloading whole tracks.
- **Local Transition Prebuffer Foundation**: `PlaybackManager` now maintains a secondary prepared `HTMLAudioElement` + hls.js pipeline for the next queued local HLS track. When playback advances to that same URL, the prepared element is promoted instead of constructing HLS playback from scratch. Browser console logs now report track-end-to-audible-start timing via `[Playback] Track transition audible after ...ms`, providing a baseline for future gapless/crossfade tuning.
- **Custom Receiver Asset Consistency**: Rebuilt `dist/` after Cast and receiver changes so the production/static assets match the current sender and receiver implementation. This fixed a temporary regression where Chromecast launched the Default Media Receiver because the served `dist/receiver.html` was stale relative to `public/receiver.html`.

## [2026-04-10] V1.0.0-beta.2: Genre Pipeline Hardening & Tuneable Penalty System
- **CTE Traversal Direction Fix**: Discovered and fixed inverted MBDB link data. `genre_tree_paths` CTE reversed from entity1→entity0 to entity0→entity1. Rock, country, folk and other root genres now appear in the materialized view (1544→1651 rows).
- **Vocabulary-Guided LLM**: All LLM prompts (Genre Matrix, Hub, Custom Playlist) now receive a 300-genre vocabulary from MBDB. Library-scoped: < 300 library genres returns actual library genres; ≥ 300 returns top 300 from MBDB hierarchy. Eliminated 91%→100% LLM failure rate.
- **Expanded Tier 2 SQL**: 6 UNION ALL branches with standalone genre parent fallback (`COALESCE(gtp.path, parent.name || '.' || g.name)`), GIN-indexed fuzzy matching (`%` operator), proper parentheses on `LIMIT 1` branches.
- **KNN 8D Fallback**: `getGenrePathFromKNN` now works with tracks missing MFCC data via 8D-only neighbor search.
- **Batch Tier 3**: Single feature fetch query replacing N sequential queries for KNN timbre fallback.
- **Hop Cost Tiers**: Deep sibling 0.05, cousin 0.20, share root 0.50, alien 2.0, unknown 2.0. Unknown genres get same penalty as alien hops.
- **Exponential Penalty Formula**: Replaced additive `distance + hopCost * weight` with multiplicative `distance * Math.pow(1 + hopCost, weight * curve)`. Wrong-genre tracks must be 2×+ closer acoustically to overcome penalty.
- **`genrePenaltyCurve` Setting**: New user slider (0-100, default 50) with live penalty preview table showing multipliers for each hop tier. Controls curve exponent from 0.5 to 2.0.
- **Infinity Mode Multiplicative**: Switched from additive to multiplicative penalty for consistency with Hub playlists.
- **Negative Space Prompting**: `banned_genres` in LLM prompt schemas. Tracks matching banned genres get `combined: Infinity` — absolute veto regardless of acoustic proximity.
- **Timbre-Weighted MFCC**: 3× MFCC weight in SQL for electronic/synthetic playlists (target acousticness < 0.3). Prioritizes instrument texture over rhythm.
- **SQL-Level Acousticness Dealbreaker**: `CASE WHEN $3::real < 0.2 AND (tf.acoustic_vector_8d::text::real[])[6] > 0.5 THEN 5.0 ELSE 0 END`. Acoustic tracks get +5.0 distance spike in electronic playlists.
- **Bug Fixes**: LLM timeout 45s→120s; custom playlist 7D→8D vector fix; `DISTINCT ON` ordering for vocabulary SQL; `LIMIT 1` parentheses in UNION ALL branches.

## [2026-04-08] v1.0.0-beta.1: Hierarchical Genre Taxonomy & 21D Recommendation Engine
- **Hierarchical Genre Migration**: Successfully replaced the static 39-macro-genre matrix with a dynamic hierarchy imported from **MusicBrainz** (~2,000 genres).
- **Materialized Tree Paths & CTE Optimization**: Created `genre_tree_paths` view using recursive CTEs. Optimized for **Root-to-Leaf** traversal, reducing generation from 38+ minutes to under 5 seconds. Fixed "stuck" status loop bug.
- **Dynamic Hop-Cost Calculation**: Replaced the matrix lookup with path-based LCA (Lowest Common Ancestor) distance math.
- **MusicBrainz High-Performance Importer**: `mbdb.service.ts` implements streaming download + extraction (`tar -xjf`) + bulk insertion of TSV data. Now records version `tag` for accurate update checking.
- **3-Step Categorization Pipeline**:
  - **SQL Match**: Direct identifier/alias lookup in MBDB.
  - **LLM Batch**: Grouped tag categorization (20 tags/batch) with strict array validation.
  - **KNN Fallback**: Weighted timbre/acoustic similarity mapping if no metadata is available.
- **8D Acoustic Vector Upgrade**: Migrated audio analysis from 7D to **8D acoustic vectors**. Recommendation ranking now uses **21 dimensions** (8D acoustic + 13D MFCC timbre).
- **Audio Analysis Hardening & Performance Audit**:
  - **SQL-Side Statistics**: Migrated `getVectorStats` to SQL-based `AVG`/`STDDEV` calculation, eliminating massive JS JSON-parsing overhead.
  - **MFCC Performance**: Pre-computed Hanning window coefficients and implemented buffer reuse, eliminating millions of redundant trig calls.
  - **NaN & Dimension Guards**: Hardened recommendation engine with `NaN` guards and vector slicing for seamless 7D/8D interoperability.
  - **is_simulated**: Added persistence for tracks analyzed with fake PCM (when ffmpeg missing) to enable future re-analysis.
  - **UX/UI**: Added phase-aware status indicators to analysis guards and scanner indicators.
- **Backward Compatibility**: Implemented vector slicing in `database/index.ts` to maintain legacy 7D data support while populating the new 8D `acoustic_vector_8d` column.
- **Resilience & Infrastructure Hardening**: Added disk space pre-checks (statfs for /tmp), fixed health-check 500 crashes during DB downtime, and stabilized container connectivity with forced IPv4 (127.0.0.1).
- **Library Removal Stability**: Implemented `purgeOrphanedTracks` and `purgeOrphanedEntities` in `database/index.ts`. This ensures that when a folder is removed, not only are the tracks deleted (with a safety net for path-encoding mismatches), but the associated albums, artists, and genres with zero remaining tracks are also purged, preventing "ghost" entries in the UI. Fixed 403 Forbidden errors for cover art and streaming on tracks orphaned by manual directory removal.
- **UI/UX Polishing**:
  - **SetupWizard Stability**: Added `localStorage` persistence for current setup step. Added "Skip MBDB Import" option to Step 3.

  - **Modular Settings Architecture**: Deconstructed monolithic `SettingsModal.tsx` into domain-specific components under `src/components/settings/` (Account, Appearance, Library, Playback, System, GenAi, GenreMatrix, Database).
  - **Settings Performance**: Encapsulated polling hooks for Genre Matrix and MBDB status within their respective tabs to eliminate root-level re-render overhead when the modal is closed.
  - **Reactive Scanner UI**: Fixed `App.tsx` scanning indicator to use reactive Zustand subscriptions for `scanPhase` and progress counts, ensuring smooth visual transitions across walk/metadata/analysis phases.
  - **Accessibility & UI Hardening**: Standardized settings navigation with semantic ARIA tab roles. Fixed transparency and styling issues in light mode for all modal components (Prompt, Confirm, DatabaseControl).

## [2026-04-03] v0.9.0: Provider Reliability & Integration Overhaul (Part 2)
- **Artist Library Lazy Loading Fix**: Artist images now load on scroll via IntersectionObserver (`useInView` hook with 200px rootMargin). Added 200ms debounce in `useArtistData` to prevent API storms during rapid scrolling.
- **Backend Modularization**: Split monolithic `externalMetadata.service.ts` into `server/services/metadata/` directory:
  - `errors.ts` — `RateLimitError` and `ProviderError` classes with type guards
  - `cache.ts` — DB caching with `updateLastUpdated` flag (skips cache update on rate limit)
  - `rateLimiter.ts` — Semaphore class + retry logic
  - `providers/lastfm.ts`, `genius.ts`, `musicbrainz.ts` — separate API clients with proper error handling
  - `index.ts` — unified API with error propagation
- **Semaphore Bug Fix**: Fixed critical bug in concurrency limiter where queued tasks never executed. `release()` now properly calls pending resolve functions.
- **Global Toast System**: Added `toasts`, `addToast`, `removeToast` to Zustand store. Created `useToast()` hook and `ToastContainer` component rendered in `App.tsx`. SettingsModal now uses global toast instead of local state.
- **Configurable Debounce**: Added `debounceMs` option to `useArtistData` (default 200ms) and `useExternalImage` (default 0ms).
- **Dual-Vector Schema**: `track_features` table extended with `mfcc_vector VECTOR(13)` (nullable). Additive schema migration — existing data is preserved. Independent HNSW index (`track_features_mfcc_idx`) added for fast 13D ANN search.
- **MFCC Extraction (Essentia.js)**: `audioExtraction.service.ts` now runs `ess.MFCC(spectrum)` inside the existing `safeCall` wrapper after the 7-feature block. Each of the 13 coefficients is sigmoid-normalized to `[0,1]` (scale 20 for k=0, scale 8 for k>0). Falls back to `0.5` per coefficient if spectrum is unavailable. `AudioFeatures` interface extended with `mfcc_vector: [13 floats]`.
- **Boot-time MFCC Migrator**: `server/index.ts` fires a non-blocking IIFE 8 seconds after startup that calls `getTracksWithoutMfcc()` and runs `runBackgroundAnalysis()` at concurrency=1 to silently backfill MFCC data for previously-analyzed tracks.
- **Timbre Imputation Bridge**: LLM concepts still send 7D target vectors (token-efficient). `getHubCollections` synthesizes a `timbreCentroid` by querying the 20 nearest acoustic neighbours that have `mfcc_vector IS NOT NULL`, averaging their MFCC values. This centroid is then used as `$2` in the combined 20D query.
- **Dual-Vector Distance Math**: All 5 query sites in `recommendation.service.ts` now use `(tf.acoustic_vector <-> $1) + (tf.mfcc_vector <-> $2) AS distance` — Hub LLM playlists, Up Next (user + global fallback), The Vault (user + global fallback), and Infinity Mode relaxation loop.
- **Graceful Degradation**: Every 20D query guards with `WHERE tf.mfcc_vector IS NOT NULL`. If zero MFCC-enriched tracks exist (fresh install, pre-migration), all engines transparently fall back to 7D-only queries so recommendations continue to work immediately.
- **Weighted Decay MFCC Centroid (Infinity Mode)**: Infinity Mode computes a parallel 13D weighted-decay centroid (lambda=0.8) matching the existing 7D centroid logic, so timbre drift tracking follows the same momentum model as the acoustic vector.

## [2026-03-31] v0.7.0: Antigravity Context — Three-Phase Scanner & Worker Thread Analysis
- **Server Modularization (Phase 0)**: Split monolithic `server/index.ts` (1625 lines) into 12 route modules under `server/routes/`. Created `server/state.ts` for shared mutable state. New structure: auth, admin, library, playback, settings, hub, playlists, artists, albums, genres, media routes.
- **Real Audio Decoding (Phase 1)**: Replaced simulated Essentia data with actual ffmpeg subprocess decoding. Implemented smart seeking: ffmpeg seeks to ~35% into track (past intro) and decodes 15 seconds for representative chorus/verse analysis. Added `ffprobe` duration detection with fallback to file start.
- **Three-Phase Scanner Architecture**: Separated library scan into distinct phases:
  - *Phase 1 (Walk)*: Recursive directory traversal collecting audio paths
  - *Phase 2 (Metadata)*: Parallel ID3/Vorbis tag extraction and DB storage
  - *Phase 3 (Analysis)*: ffmpeg + Essentia audio feature extraction via worker threads
- **Worker Thread Implementation**: Created `server/workers/audioAnalysis.worker.ts` and `server/workers/analyzeTrack.ts` to offload CPU-intensive Essentia WASM processing from main thread. Workers spawn persistent `tsx` child processes communicating via newline-delimited JSON over stdin/stdout. Prevents server unresponsiveness during batch analysis.
- **Non-ASCII Filename Support**: Implemented temp symlink workaround for files with special characters (Danish `øæ`, em-dashes, curly quotes). Raw Buffer paths create symlinks in `/tmp/am-*/`, passed to ffmpeg, cleaned up after processing. Solves Node.js spawn UTF-8 encoding limitations.
- **Safe Essentia Processing**: Wrapped each Essentia algorithm (Energy, Spectrum, DynamicComplexity, PitchSalience, Flux, ZeroCrossingRate, Danceability) in individual try-catch blocks with graceful fallback to 0. Prevents single algorithm crash from killing entire track analysis.
- **Per-Directory Library Stats**: Added `GET /api/library/stats` endpoint returning `{ totalTracks, withMetadata, analyzed }` per mapped folder. Updated SettingsModal Library tab with coverage progress bars and real-time stats refresh after folder operations.
- **Concurrency Control**: Connected `audioAnalysisCpu` setting (Background=1, Balanced=4, Maximum=6 workers) to analysis worker pool size. Added per-file 90-second timeout to prevent hung files from blocking batch.
- **Scan Status Improvements**: Metadata and analysis phases now show `"Artist - Title"` format in scanning indicator instead of just filename. Added new "Audio Analysis" section in Settings → Library with "Analyze Missing" and "Re-analyze All" buttons plus library-wide coverage progress bar.

## [2026-03-29] v0.6.0: LLM Deduplication Fix, Tunable Settings & Button Unification
- **LLM Playlist Deduplication Bug Fix**: Fixed `getHubCollections()` in `recommendation.service.ts` where 5 LLM playlists could contain identical songs. Root cause: each concept queried the database independently with no shared exclusion set. Fix accumulates an exclusion set of already-assigned track IDs across the concept loop, with a `WHERE t.id NOT IN (...)` clause.
- **New Tunable Settings**: Added 4 user-facing settings to the Playback tab (LLM Playlists sub-tab):
  - *Playlist Diversity* (0–100%): Wander factor — weighted randomization vs deterministic top-N selection.
  - *Genre Blend Weight* (0–100%): Hop cost multiplier replacing the hardcoded `0.5` value.
  - *Tracks per Playlist* (5/10/15/20): Configurable playlist length.
  - *Number of Playlists* (2/3/5): How many LLM concepts to generate per cycle.
- **LLM Prompt Improvement**: Added diversity instruction to the LLM prompt (`generateHubConcepts`) to enforce distinct acoustic profiles between concepts.
- **Unified Button System**: Replaced 27+ inline Tailwind button strings in SettingsModal.tsx with global CSS classes in `index.css`. New variant system: `.btn`, `.btn-primary`, `.btn-danger`, `.btn-danger-fill`, `.btn-ghost`, `.btn-lg`, `.btn-sm`, `.btn-tab`, `.btn-dashed`, `.btn-icon`. Removed old `.btn-small`, `.remove-btn`, `.icon-btn`.
- **Nav Button Fix**: Fixed asymmetric padding on Hub/Playlists/Artists/Albums/Genres navigation buttons caused by `pb-0` on the container.

## [2026-03-23] v0.5.0: AI Playlists, Queue Architecture & System Resilience
- **Database Resilience**: App now boots even if PostgreSQL is unreachable, displaying a full-page graceful error UI that polls for health recovery.
- **Robust LLM Integration**: Rewrote `llm.service` response parsing to handle unpredictable local LLM outputs (LM Studio, Ollama). SetupWizard now includes a dedicated LLM configuration step with token usage estimation and live connection testing. Added manual custom playlist generation via a prompt modal.
- **Recommendation Engine Upgrades**: Engine-driven playlists now use advanced math:
  - *Up Next & The Vault*: Re-ranked using a custom `reRankByHopCost` blending acoustic vector distance with a pre-calculated genre adjacency matrix.
  - *Jump Back In*: Replaced a broken rating system with a Heat Score calculation (`playCount × quadratic time decay`).
- **Global Track Context Menu**: Engineered a React Portal-based context menu (`TrackContextMenu`) accessible via a `⋯` button anywhere a track is rendered (Album, Search, Queue). Supports "Play Next" and "Add to Playlist" globally.
- **Drag-and-Drop Play Queue**: Refactored the `PlaylistSidebar` to support smooth drag-and-drop track reordering with visual drop indicators, hover drag handles, and transparent drag ghosts.

## [2026-03-13] v0.4.0: Glassy UI Phase 2 & Audio Waveforms
- **Waveform Progress Bar**: Implemented a canvas-based `WaveformProgressBar` using the Web Audio API to decode audio files on-the-fly and render amplitude peaks as interactive bars.
- **Glassy Design System**: Refined the theme with a "premium glass" aesthetic:
  - **Player Controls**: Dark-on-light (light mode) and white-on-dark (dark mode) frosted glass buttons with purple gradient accents.
  - **Tab Navigation**: Replaced underlines with glassy pill buttons featuring glow effects and hover states.
- **Unified Album Display**: Created a shared `AlbumCard` component with a fade-in play overlay. Standardized album displays across `LibraryHome`, `ArtistDetail`, and `GenreDetail`.
- **Artist Credits**: Added "Also Appears On" logic to the Artist Detail view to surface guest features separate from primary releases.
- **Light Mode Parity**: Optimized all new glassy components for visibility and accessibility in Light Mode using theme-aware CSS variables.

## [2026-03-12] v0.3.0: Security, Integrations & Onboarding
- **External Imagery APIs**: Integrated Last.fm and Genius APIs to fetch artist bios, fallback album art, and artist hero images dynamically on the frontend with caching.
- **Backend Security**: Implemented path traversal sanitization and Express Basic Authentication middleware (`requireAuth`) to safely host the application on the public web.
- **First-Time Setup Wizard**: Built a glassmorphic onboarding UI (`SetupWizard.tsx`) that bypasses auth on the very first boot to dynamically write admin credentials to the server's `.env` file natively.
- **Basic Auth URL Params**: Restructured frontend streaming and image rendering to append a base64 encoded auth `?token=` parameter to bypass stringent browser subresource credential stripping.


## [2026-03-12] v0.2.0: UI Polish & Background Refactor
- **Matte Glass Background**: Replaced resource-heavy `HeroWave` canvas with a CSS-based Matte Glass background.
  - Implemented multi-point radial gradients on the `body` selector.
  - Added a `noise.svg` turbulence filter overlay for a textured "matte" finish.
- **Glassmorphism Reversion**: Completely removed "Brutalist Editorial" styling.
  - Restored rounded corners (`2xl`), soft shadows, and `backdrop-blur` across all components.
  - Simplified typography to standard sentence-cased font weights.

## [2026-03-11] v0.1.0: Library-Centric Architecture (The Big Shift)
- **Backend Infrastructure**: Launched Node.js + Express server to handle file system operations.
  - Integrated SQLite for library persistence.
  - Implemented `/api/library` and `/api/stream` endpoints.
- **Navigation System**: Created a library-first UI with tabs for Artists, Albums, and Genres.
  - Added `AlbumDetail`, `ArtistDetail`, and `GenreDetail` sub-views.
- **Theme System**: Implemented Tailwind-based dark mode (`.dark`) with persistent user preference in Zustand.

## [2026-03-10] v0.0.1: Core Player & Audio Engine
- **PlaybackManager**: Developed a singleton class for consistent audio handling.
- **Zustand Store**: Reorganized state to handle playlists, volume, and scanning states.
- **UI Base**: Implemented `PlayerControls`, `ProgressBar`, and `PlaylistSidebar`.
- **Keyboard Shortcuts**: Added global listeners for spacebar, arrows, and volume control.
