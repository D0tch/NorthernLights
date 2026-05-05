# Product.md — Aurora Player

Companion to [design.md](./design.md). Where `design.md` describes *how Aurora looks*, this document describes *what Aurora is, who it's for, and what we will and won't build*. Feature inventory lives in [README.md](./README.md), [docs/core_features.md](./docs/core_features.md), and [docs/nice_to_have.md](./docs/nice_to_have.md) — this doc explains the reasoning that lets us decide which features ship.

---

## 1. One-line Product Definition

**Aurora is a self-hosted music player that treats your local library as the canon and uses AI to make it endlessly listenable.**

Every word is load-bearing:

- **Self-hosted** — the user runs the server. We never host their music.
- **Music player** — not a media server (no video), not a streaming service (no remote catalog), not an audiophile DSP suite.
- **Local library as the canon** — every recommendation, playlist, search, and similarity result is computed *against the user's files*. The library is not a seed for external APIs; it is the universe.
- **AI to make it endlessly listenable** — the differentiator. Plex/Jellyfin/Subsonic browse a library; Aurora *animates* one.

If a feature proposal contradicts that sentence, it's out of scope.

---

## 2. Audience

Aurora is built for one user shape. Designing for everyone produces a worse product than designing for someone.

### The canonical user

- Owns 5,000–500,000 tracks across mixed formats (FLAC, MP3, OGG, WMA legacy).
- Has run a home server before — Plex, Jellyfin, Nextcloud, Home Assistant, NAS.
- Has tried Navidrome, Airsonic, Plexamp, or Roon, and was either bored by the UI or constrained by the recommendation quality.
- Listens daily, across desktop, phone, and Chromecast/TV.
- Wants ownership: no streaming-service algorithm deciding what they hear.
- Cares about how the app *feels*, not just what it does. Will judge a music player on typography.

### Secondary users (covered, not designed for)

- Family members of the canonical user, accessing via invite-issued accounts.
- Audio collectors with very large hi-res libraries (FLAC/ALAC/WAV) who need format breadth more than ML.
- Friends of the canonical user, listening via shared link or invite, on phone PWAs.

### Explicitly not the audience

- **Streaming-service users** who don't own files. They have Spotify; we won't out-feature it.
- **Audiophiles seeking DSP / room correction / parametric EQ.** That's Roon's lane.
- **Enterprises / multi-tenant deployments.** Aurora is single-server, single-household.
- **Mobile-only DJs / mixers.** Different product entirely.
- **People who want a generic "media server".** Aurora is music, not movies. Use Jellyfin alongside it.

---

## 3. The Bet (Positioning)

The streaming era taught two generations that listening is *flow* — endless, contextual, mood-driven. The self-hosted era preserved *ownership* but mostly delivered file-browser UX: artists, albums, folders, play. Aurora is the bet that **flow and ownership are not opposed** — that you can have Spotify-quality listening over your own files, with no telemetry, no algorithmic agenda, no rented catalog.

**The wager:** A user with 50,000 tracks, given the right recommendation engine, has a richer listening universe than the average Spotify subscriber has access to. They just need an interface that surfaces it.

That bet drives every architectural decision:

- **21-dimensional similarity** (8D acoustic + 13D MFCC) — because shallow tag matching produces the same five albums.
- **MusicBrainz hierarchical genre ontology** — because flat genre lists treat "death metal" and "ambient" as siblings of "rock".
- **Library-relative LLM compilation** — because asking an LLM for "songs like X" is useless if it returns songs the user doesn't own.
- **Hub playlists** — because the home screen should always have a reason to start playing *right now*.
- **Glassmorphism + aurora aesthetic** — because the felt experience of opening the app matters as much as the feature checklist.

We are not competing on feature parity with Plex Music or Navidrome. We are competing on whether opening Aurora at 9pm on a Tuesday makes you want to listen for two hours.

---

## 4. Product Principles

Decisions get made against these. When two principles conflict (and they will), the higher-numbered one yields.

### 1. The library is the canon

Every surface answers the question: *what's in this user's library?* External providers (Last.fm, Genius, MusicBrainz, JamBase) enrich library entities — they never replace them. We do not show "you might like this artist (who isn't in your library)" as a primary affordance. Discovery happens *within* the owned collection.

**Consequence:** `Hub` recommendations resolve concept paths against the local library before generating; Up Next/Vault never recommend tracks the user doesn't own; "similar artists" prefers locally-owned artists, with external as a tertiary slot.

### 2. The user owns their data, period

No telemetry. No phoning home. No cloud account required for core features. `.env` and PostgreSQL are the entire surface area of "user data." If a feature requires a cloud account, it is opt-in, marked, and strictly enrichment.

**Consequence:** Cloud LLMs (OpenAI) are supported but local LLMs (LM Studio, Ollama) are first-class. AI Hub works offline if the user runs a local model. Authentication is JWT-local; we do not federate.

### 3. Premium feel is a feature, not a polish step

Self-hosted music software has historically looked like 2010 file managers. Aurora's aesthetic — Aurora Northern Lights brand, glassmorphism, Syne + DM Sans, the emerald play disc — is core product, not chrome. A new feature that ships with utilitarian UI is *not done*. This principle is what `design.md` exists to enforce.

**Consequence:** The custom CAF Cast receiver is Aurora-branded, not the default media receiver. The setup wizard is glassmorphic. Settings is Discord-style centered, not a sidebar list of checkboxes. Loading states are designed.

### 4. Fast enough to feel free

If a recommendation takes 8 seconds, users stop trusting it. Performance is a product property, not an engineering concern. Targets:

- **Library scan:** thousands of tracks per minute in metadata phase.
- **Hub generation:** under 5s for 5 playlists.
- **Up Next / similarity queries:** under 200ms (HNSW vector index).
- **Track-to-track transition:** prewarmed HLS sessions, sub-second audible start.
- **Cold app open:** under 1.5s to interactive on broadband.

**Consequence:** pgvector HNSW is non-negotiable. Worker threads for analysis. Three-phase scanner so tracks appear before they're fully analyzed. Prewarming the next track. Cache headers on cover art.

### 5. Opinionated, not configurable

Configuration is a tax on every user paid to satisfy a few. We pick defaults that work for the canonical user and expose tuning only when a real listening experience demands it (Hub diversity, recovery strength, genre cohesion). We do *not* expose font choice, layout density, theme accent, or every server knob.

**Consequence:** Two themes (light, dark). One font pair. One layout. Settings are domain-organized, not power-user-organized. The Aurora aesthetic is fixed — users don't theme it.

### 6. Local-first, network-resilient

Aurora is a single-machine product that must keep working when the network has a bad day. PWA installable. Service worker caches the shell. Offline guards on external metadata calls (rate-limit + retry). Database disconnects render a graceful recovery page, not a crash.

**Consequence:** External metadata is wrapped in `RateLimitError` / `ProviderError` and a semaphore. Cover art is cached locally. The app boots even if PostgreSQL is unreachable, polling for recovery.

### 7. Open standards over proprietary

HLS for streaming. PostgreSQL + pgvector for storage. MusicBrainz for genre ontology. ID3/Vorbis/ASF for tags. JWT for auth. We do not invent file formats, we do not invent audio codecs, we do not lock data into Aurora-only structures. A user who wants to leave can walk away with their files and their PostgreSQL dump.

**Consequence:** No proprietary "Aurora library file." No DRM. Library state is reconstructable from the filesystem.

---

## 5. Non-Goals (the doors we keep closed)

A product is also defined by its refusals. These have all been considered and declined. Reopening them requires an explicit principle override.

| Non-goal | Why not |
|---|---|
| **Streaming-service catalog access** (Spotify / Apple Music / Tidal integration) | Violates Principle 1. The library is the canon, not a seed. |
| **Video / generic media server** | Aurora is music. Jellyfin and Plex own video; we will not split focus. |
| **Subsonic / Airsonic API compatibility** | Locks us into a 2007 API. Navidrome owns that lane; we'd inherit constraints with no upside. |
| **Audiophile DSP** (parametric EQ, room correction, upsampling, MQA) | Roon's lane. Different audience, different price point, different software architecture. |
| **DJ / mixing tools** (BPM sync, crossfade DJ mode, cue points) | Different product. Crossfade may exist as a small playback affordance; full DJ tooling will not. |
| **Federated / multi-server / multi-tenant SaaS** | Aurora is one server, one household. Multi-tenant changes auth, billing, ops, and the entire product shape. |
| **Mobile native apps (iOS/Android)** | The PWA is the mobile experience. Native apps double the surface area without a corresponding product gain. |
| **Generic plugin architecture** | Plugins fragment quality and aesthetic. Integrations are first-party (Last.fm, Genius, JamBase) or not at all. |
| **Telemetry, analytics, "anonymous usage data"** | Violates Principle 2. Even opt-in, it sets a norm we don't want. |
| **Theming / user-supplied skins** | Violates Principle 5. Aurora *is* the aesthetic. |
| **Built-in podcast / audiobook support** | Different metadata models, different listening behaviors, different player UX. Not a music player concern. |
| **Social features** (followers, shared listening, public profiles) | Self-hosted product; the social graph belongs elsewhere. |

---

## 6. Roadmap Heuristic

We do not maintain a fixed roadmap. We maintain a *judgment* about what to do next. A feature is a candidate when:

1. It is **central to the bet** (§3) — it makes the listening flow richer, smoother, or more contextual.
2. It is **library-relative** — it works on what the user owns, not what the cloud knows.
3. It **honors the principles** — especially feel, performance, and ownership.
4. It is **architecturally cheap** — it composes with existing primitives (recommendation service, three-phase scanner, glass design system) rather than introducing a parallel stack.

A feature is *not* a candidate just because:

- A user requested it.
- A competitor ships it.
- It's technically interesting.
- It would close a feature-parity gap with Spotify / Plex / Roon.

For specific upcoming work, see [docs/nice_to_have.md](./docs/nice_to_have.md). For shipped milestones, see [MEMORY.md](./MEMORY.md). For implementation plans, see [TASKS.md](./TASKS.md).

---

## 7. Quality Bars (definition of "shipped")

A feature is shipped when *all* are true:

- [ ] Works on Chrome desktop, Safari iOS PWA, and Chromecast (if playback-related).
- [ ] Light mode and dark mode both audited.
- [ ] Mobile layout designed, not just "responsive enough."
- [ ] No new telemetry, no new third-party JS bundles without justification.
- [ ] Empty state, loading state, and error state are designed — not stub text.
- [ ] Performance targets (§4 Principle 4) met or exempted with reason.
- [ ] Honors `prefers-reduced-motion`, focus-visible, keyboard navigation.
- [ ] Reads natural to a user who has never seen the feature before — no jargon leaked from internals.
- [ ] `npx tsc --noEmit` clean. `npx vite build` clean.

If a feature ships missing any of these, it ships marked beta in the UI, not silently.

---

## 8. Voice & Copy

Product copy reinforces brand. A few rules:

- **No exclamation marks.** Aurora is calm. "Library scanned" not "Library scanned!"
- **Lowercase status verbs.** "scanning…", "analyzing…", "compiling concepts…"
- **Title-case only for proper nouns and headlines.** Section headers are uppercase short labels (`LIBRARY`, `PLAYBACK`).
- **No "AI magic" hype.** Say what it does. "Generates 5 playlists from your library" beats "AI-powered intelligent playlist creation."
- **No second-person scolding.** "No tracks found" not "You haven't added any music yet."
- **Numerics tabular.** Always.
- **Don't say "songs" or "playlist" when you mean "tracks" or "queue."** The lexicon: *track, album, artist, genre, queue, playlist, hub, vault*.

---

## 9. Success Signals

We don't currently collect telemetry (Principle 2), so success is judged qualitatively. We are succeeding when:

- A canonical user replaces Spotify with Aurora as their primary listening app, not just their archive viewer.
- Time spent listening per session climbs after the first week (the recommendation engine is doing its job).
- The Hub home screen becomes the default entry point, not the artist/album browser.
- Self-hosting friends install it after one demo, without needing a sales pitch.
- The aesthetic gets screenshotted.

We are failing when:

- Users open Aurora, browse to an album they already know, play it, and leave.
- The Hub feels random, repetitive, or stale.
- Setup is the most-mentioned topic in issues.
- Users describe Aurora as "like Plex but for music."

---

## 10. Strategic North Star

**Make a music player a person would choose over Spotify, on a library they already own, without ever describing it as a tradeoff.**

Every other decision is downstream of that.
