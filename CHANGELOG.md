# Changelog

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