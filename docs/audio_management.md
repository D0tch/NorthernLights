# Audio Management

## Playback Engine
- **HTML5 Audio + hls.js**: Uses a single `HTMLAudioElement` wrapped by a `PlaybackManager` singleton. Audio is delivered via HLS (HTTP Live Streaming) using `hls.js` on desktop browsers and native HLS on iOS Safari.
- **Source Handling**: Audio is served via the `/api/stream/:trackId/playlist.m3u8?quality=<quality>` endpoint. Individual `.ts` transport stream segments are served from `/api/stream/:trackId/<segment>.ts`.
- **Seeking**: HLS segments are individually addressable — scrubbing/seeking loads only the relevant chunk without re-downloading the entire stream.
- **AudioContext**: Initialized on the very first user interaction (click/touch in `App.tsx`) to comply with Safari's autoplay policy. The `PlaybackManager.ensureAudioContext()` method creates the context in a suspended state and connects the `MediaElementAudioSourceNode`.

## HLS Streaming Architecture

### Overview
Audio files are sliced into 10-second HLS chunks on-the-fly by FFmpeg on the backend. The frontend consumes these via `hls.js` (or native HLS on iOS Safari). The Service Worker caches individual `.ts` chunks for offline playback.

### Backend: On-the-Fly HLS Generation

**Services**: `server/services/hlsStream.service.ts` (fixed presets) and `server/services/adaptiveHlsStream.service.ts` (Auto)
**Route**: `server/routes/media.routes.ts`

```
Client Request → /api/stream/:trackId/playlist.m3u8?quality=128k
                    ↓
          Track lookup from PostgreSQL (path, bitrate)
                    ↓
          Security check (isPathAllowed)
                    ↓
          getOrCreateHlsSession()
                    ↓
          FFmpeg spawns → writes to os.tmpdir()/nl-hls-streams/<trackId>-<quality>/
                    ↓
          Serves playlist.m3u8 once first segment is ready
```

For `quality=auto`, the master playlist is source-aware and contains an AAC ladder selected from 64/128/160/320 kbps. Known lossy sources are capped at their stored source bitrate. Lossless sources and sources without reliable bitrate metadata may use the full 320 kbps ceiling. Browser Data Saver requests `maxBitrate=64k`, producing a one-rendition Auto master.

Adaptive media packaging decodes the input once. One FFmpeg process uses `asplit` plus `var_stream_map` to encode every rendition and write aligned 10-second MPEG-TS playlists under one session directory:

```text
os.tmpdir()/nl-adaptive-hls-streams/<session-hash>/
  64k/playlist.m3u8 + segmentNNN.ts
  128k/playlist.m3u8 + segmentNNN.ts
  160k/playlist.m3u8 + segmentNNN.ts
  320k/playlist.m3u8 + segmentNNN.ts
```

The service does not mark the package ready until every rendition playlist has at least two segments (or a complete one-segment short track). Sessions deduplicate by exact track, ladder, and codec. A failed zero-segment process is discarded so the next request can create a fresh session.

### The Source Rule (Remux vs Transcode)

The backend evaluates the requested quality against the source file's bitrate (stored in the `tracks.bitrate` column during library scan):

| Condition | Action | FFmpeg Flag |
|-----------|--------|-------------|
| Browser `source`, natively playable codec | Stream original bytes with Range support | HLS bypassed |
| HLS `source`, TS-compatible codec matches target | **Remux**, change container only | `-c:a copy` |
| Fixed preset at/above source bitrate, codec matches target | **Remux**, no upsampling | `-c:a copy` |
| Incompatible codec/container or lower fixed preset | **Transcode** to AAC | `-c:a aac -b:a <quality>` |

Remuxing uses negligible CPU and preserves original quality. `source` never becomes a literal FFmpeg bitrate; incompatible HLS sources use a real bounded transcode bitrate instead.

### Quality Tiers

| Setting | Bitrate | Description |
|---------|---------|-------------|
| `auto` | Adaptive 64–320 kbps AAC | Browser hls.js/native HLS selects from a source-aware ladder |
| `64k` | 64 kbps | Low quality, saves bandwidth |
| `128k` | 128 kbps | Normal — good balance |
| `160k` | 160 kbps | High quality |
| `320k` | 320 kbps | Very High — near-lossless |
| `source` | Original | No conversion, direct file remux |

Quality is persisted in the Zustand store (`streamingQuality`) and applied when building track URLs.

`auto` is preserved in hydrated library, playlist, continuity, prepared-track, and runtime playback URLs. Chromecast has a separate resolver: both `auto` and `source` become fixed 128 kbps AAC for the current custom receiver path.

### Session Lifecycle

- Fixed sessions are keyed by `trackId::quality::codec`
- Adaptive sessions are keyed by `trackId::ladder::codec`
- Reused if an identical session exists (no duplicate FFmpeg processes)
- Auto-reaped after 30 minutes of inactivity
- All sessions cleaned up on server shutdown (SIGINT/SIGTERM)
- Output directory: `os.tmpdir()/nl-hls-streams/`
- Adaptive output directory: `os.tmpdir()/nl-adaptive-hls-streams/`

### FFmpeg Command

```bash
ffmpeg -i <input> -vn -map 0:a:0 \
  [-c:a copy | -c:a aac -b:a 128k] \
  -hls_time 10 -hls_list_size 0 \
  -hls_segment_filename <dir>/segment%03d.ts \
  -hls_flags independent_segments \
  -f hls <dir>/playlist.m3u8
```

Adaptive Auto uses one input and one process:

```bash
ffmpeg -i <input> -vn \
  -filter_complex '[0:a:0]asplit=4[a0][a1][a2][a3]' \
  -map '[a0]' -c:a:0 aac -b:a:0 64k -profile:a:0 aac_low \
  -map '[a1]' -c:a:1 aac -b:a:1 128k -profile:a:1 aac_low \
  -map '[a2]' -c:a:2 aac -b:a:2 160k -profile:a:2 aac_low \
  -map '[a3]' -c:a:3 aac -b:a:3 320k -profile:a:3 aac_low \
  -hls_time 10 -hls_list_size 0 -hls_playlist_type event \
  -hls_segment_filename '%v/segment%03d.ts' \
  -var_stream_map 'a:0,name:64k a:1,name:128k a:2,name:160k a:3,name:320k' \
  -f hls '%v/playlist.m3u8'
```

### Frontend: hls.js Integration

**File**: `src/utils/PlaybackManager.ts`

- `playUrl()` detects `.m3u8` URLs and routes to `playHls()`
- `playHls()` creates an `Hls` instance with `maxBufferLength: 60` (buffers 60s ahead)
- Auto seeds hls.js's ABR estimator from Network Information `downlink` when available; otherwise hls.js keeps Aurora's explicit 500 kbps cold-start estimate.
- hls.js remains in normal automatic level selection. `MANIFEST_PARSED` and `LEVEL_SWITCHED` update active bitrate, estimated bandwidth, rendition count, and switch count in in-memory playback telemetry. Fragment samples do not write to Zustand.
- A live Data Saver change caps `autoLevelCapping` at the 64 kbps level immediately. Native Safari HLS has no level-selection API, so it receives the capped master on the next load and reports `Auto` without an observable active rendition.
- Waits for `MANIFEST_PARSED` event before calling `safePlay()`
- iOS Safari fallback: uses native `<audio>` element with HLS src directly
- `safePlay()` handles `NotAllowedError` (autoplay blocked) gracefully
- If adaptive packaging or playback exhausts recovery, Aurora retries once at fixed 64 kbps with Data Saver or fixed 128 kbps otherwise, recording `fixed-quality-after-adaptive-failure`.

### Prewarm and prepared-track behavior

`POST /api/stream/:trackId/prewarm?quality=auto` prepares all renditions in one FFmpeg process. Conservative policy prepares the immediate next track. Aggressive policy may prewarm the next two server packages while retaining one local prepared `HTMLAudioElement` for promotion. Each Auto track still consumes one FFmpeg process, not one process per rendition. Offline, Data Saver, and 2G safeguards remain in the frontend prewarm manager; Data Saver playback itself still requests the 64 kbps Auto master.

### Packaging benchmark (2026-07-14)

Measured with reproducible 60-second 44.1 kHz pink-noise fixtures, one FLAC and one 160 kbps MP3, on the development host. Readiness is Aurora's two-segment threshold. Peak RSS and CPU/storage are full-process measurements, so they describe packaging cost rather than steady playback memory.

| Input / package | Renditions | Ready | Wall | User CPU | Peak RSS | Temp storage |
|---|---:|---:|---:|---:|---:|---:|
| FLAC, fixed 128 kbps | 1 | 268 ms | 0.32 s | 0.34 s | 70,612 KB | 1,040 KB |
| FLAC, Auto 64/128/160/320 | 4 | 503 ms | 1.30 s | 2.22 s | 72,384 KB | 4,468 KB |
| MP3 160 kbps, fixed 128 kbps | 1 | 271 ms | 0.33 s | 0.36 s | 69,532 KB | 1,040 KB |
| MP3 160 kbps, Auto 64/128/160 | 3 | 203 ms | 0.37 s | 0.95 s | 70,896 KB | 2,856 KB |

All generated rendition playlists had identical segment names and duration boundaries. Process inspection and FFmpeg arguments confirmed one FFmpeg process per Auto track. Adaptive and fixed temp sessions retain the same 30-minute inactivity cleanup contract.

### Client-Side Caching (Service Worker)

Configured via Workbox in `vite.config.ts`:

| Pattern | Strategy | Cache Name | TTL |
|---------|----------|------------|-----|
| `*.ts` segments | CacheFirst | `nl-audio-chunks-v1` | 7 days, 2000 entries |
| `*.m3u8` playlists | NetworkFirst | `nl-audio-playlists-v1` | 1 day, 200 entries |
| `/api/art` | CacheFirst | `media-cache` | 30 days, 500 entries |

Segments are immutable (cache-forever safe). Playlists use NetworkFirst so they're always fresh, with cache fallback for offline.

Adaptive Auto requests have an additional failure-only cache fallback. hls.js may choose a different rendition when a cached track is replayed offline, even though only the rendition used during the original playback exists in Cache Storage. Workbox still prefers an exact URL while online, but if that request fails it may reuse a cached playlist or time-aligned segment with the same track/path and different adaptive query parameters. This preserves live ABR behavior, makes already-cached Auto playback rendition-agnostic offline, and leaves fixed-quality and Source cache matching unchanged. Existing `nl-audio-*` cache names are retained so entries created before this behavior remain usable.

### Album Artwork

Covers are **pre-encoded to AVIF during library scans** rather than extracted and resized on every request. See "Album Artwork Pipeline" below. Because the cached art URL is keyed by the cover's content hash (`/api/art?hash=<hash>&size=<256|640|1024>`), every track on an album shares one URL — so the service worker stores **one** entry and the browser decodes **one** bitmap per album, not one per track. The hashed responses are served `immutable`, so a cache hit never revalidates.

## Audio Analysis Pipeline

### Overview
The application extracts acoustic features from audio files to power the recommendation engine (Infinity Mode, Hub playlists). This is implemented as a **three-phase process**:

1. **Metadata Phase** (Library Scan): ID3/Vorbis/ASF tags extracted and stored in PostgreSQL. The embedded cover is also encoded to AVIF here (see "Album Artwork Pipeline").
2. **Analysis Phase** (Worker Threads): ffmpeg + Python + TensorFlow extract high-dimensional feature vectors:
   - **8D Acoustic Vector** (Rhythm, style, and instrumentation)
   - **1280D Discogs-EffNet Embedding** (Neural timbre and production fingerprint)
3. **Feature Storage**: Results stored in `track_features` table with pgvector HNSW indexing for ultra-fast similarity search.

### Technical Implementation

#### ffmpeg Decoding
```
ffmpeg -ss <seek_to_35%> -i <input> -t 15 -f f32le -ac 1 -ar 44100 pipe:1
```
- **Smart Seeking**: Seeks to ~35% into the track (past intros/silence) to capture a representative segment of the chorus or main verse.
- **15-Second Window**: Captures sufficient audio for the ML models to generate stable embeddings while minimizing memory and CPU overhead.
- **Raw PCM Output**: Decodes to 32-bit little-endian float mono PCM for the analysis engine.

#### Python ML Engine
The analysis has transitioned from WASM-based processing to a dedicated **Python 3** engine using the **Essentia Python library** and **TensorFlow** models.

**MusiCNN (8D Acoustic Features)**:
Extracted using the MusiCNN classification model and traditional DSP algorithms:
1. **Energy** — Overall amplitude and loudness.
2. **Brightness** (Spectral Centroid) — Frequency balance (high-frequency content proxy).
3. **Percussiveness** (Dynamic Complexity) — Rhythmic energy variation.
4. **Pitch Salience** — Harmonic clarity/tonality.
5. **Instrumentalness** (ML-derived) — Probability that the track is instrumental.
6. **Acousticness** (ML-derived) — Probability of acoustic vs. synthetic instruments.
7. **Danceability** (ML-derived) — Rhythmic stability and "grid" adherence.
8. **Tempo** — Normalized BPM estimation.

**Discogs-EffNet (1280D Neural Embedding)**:
The primary system for timbre and production similarity. It uses a **EfficientNet-based model** (Discogs-EffNet) to generate a high-fidelity **1280-dimensional** embedding.
- **Neural Timbre**: Captures the "texture" of the audio (e.g., tube saturation, reverb style, specific synthesizer characteristics).
- **L2 Normalization**: Embeddings are L2-normalized at extraction time to allow for **Cosine Similarity** search in PostgreSQL.

#### Worker Thread Architecture
```
Main Thread (Express Server)
  ├── Worker 1 → spawn("tsx analyzeTrack.ts")
  │     └── persistent child_process → extractor.py (Python ML)
  ├── Worker 2 → spawn("tsx analyzeTrack.ts")
  │     └── persistent child_process → extractor.py (Python ML)
  ...
```
- **Process Isolation**: Node.js manages a pool of `analyzeTrack.ts` workers. Each worker keeps one Python `extractor.py` process alive and sends multiple track jobs over stdin/stdout so the TensorFlow models load once per worker.
- **Resource Management**: Concurrency is adjusted via the "Audio Analysis Workers" setting in the UI.
- **Concurrency Control**: `audioAnalysisCpu` setting (Background=1, Balanced=4, Maximum=6 workers)
- **Protocol**: Newline-delimited JSON over stdin/stdout
- **Process Lifetime**: Persistent child processes per worker, handling multiple tracks

#### Non-ASCII Filename Support
Node.js spawn always UTF-8 encodes arguments, mangling special characters. Workaround:
```typescript
// 1. Create temp symlink with ASCII-safe name
const tmpDir = fs.mkdtempSync('/tmp/am-XXXXXX');
const symlink = path.join(tmpDir, 'input.flac');
fs.symlinkSync(Buffer.from(rawBytes), symlink);

// 2. Pass symlink to ffmpeg (preserves raw bytes via Buffer API)
// 3. Clean up temp directory after processing
```

Handles: Danish `øæ`, em-dashes `–`, curly quotes `'` `"`, and other UTF-8 multi-byte sequences.

### Database Schema
```sql
CREATE TABLE track_features (
  track_id TEXT REFERENCES tracks(id) ON DELETE CASCADE PRIMARY KEY,
  bpm NUMERIC,
  acoustic_vector_8d VECTOR(8),  -- 8D acoustic semantic
  embedding_vector VECTOR(1280)  -- 1280D Discogs-EffNet Timbre
);
CREATE INDEX track_features_idx ON track_features USING hnsw (acoustic_vector_8d vector_cosine_ops);
CREATE INDEX track_features_effnet_idx ON track_features USING hnsw (embedding_vector vector_cosine_ops);
```

### Normalization
Features are normalized using native SQL aggregation for ultra-fast library-wide computation:
```sql
SELECT AVG(acoustic_vector_8d), STDDEV(acoustic_vector_8d) FROM track_features
```
Z-score normalization per-dimension, then sigmoid to [0,1] range.

### Timbre-Weighted EffNet Similarity
For electronic/synthetic playlists (target acousticness < 0.3), Discogs-EffNet embedding similarity is weighted more heavily in the SQL query to prioritize instrument texture and production character over rhythm alone.

### SQL-Level Acousticness Dealbreaker
An asymmetric penalty applied in SQL: if the playlist targets EDM (acousticness < 0.2) but a track is fully acoustic (> 0.5), it receives a +5.0 distance spike at the query level.

## Album Artwork Pipeline

Local covers are encoded once, at ingestion time, instead of being extracted and resized on every request. This removes a per-request audio-file parse and, more importantly, caps decoded-bitmap memory in the browser (a full-resolution cover can be 1000–3000px; a grid of them decoded at full size used to consume hundreds of MB and could OOM mobile tabs).

**Resolution and encoding (scan time).** During the Metadata Phase, the `scanTrack` worker validates every embedded picture with `sharp`. It prefers front-cover images, then square/high-resolution candidates. ASF/WMA recovery removes bytes before a recognized image header and reconstructs JPEG streams whose SOI/JFIF prefix was lost, accepting a repair only when `sharp` can decode it. If no embedded candidate is valid, Aurora checks the track directory in this order: `cover`, `folder`, `front`, `AlbumArt*_Large`, then `AlbumArt*_Small`/`AlbumArtSmall` (JPEG, PNG, WebP, or AVIF). Unrelated images are ignored.

The chosen local image is hashed (SHA-256, first 32 hex chars) and encoded to AVIF variants at **256 / 640 / 1024 px** via `sharp` (`quality 62`, `effort 4`). Files are written to `ART_CACHE_DIR` (default `./art-cache`), sharded by hash prefix: `art-cache/<ab>/<hash>_<size>.avif`. Encoding is keyed by content hash and skips any variant already on disk, so an album's tracks that share identical art produce **one** file set.

**Change detection and parser upgrades.** `tracks.file_mtime` is recorded per file. A scan reprocesses a file when it is new **or** its mtime changed (a re-tag), so replaced embedded covers are re-encoded; the displaced hash is removed if no other track still references it. `tracks.artwork_version` records which resolver processed the file. When recovery logic changes, only stale rows are queued for a one-time automatic metadata pass. The WMA recovery upgrade specifically leaves previously artless `ASF/audio` rows stale, while successful and non-WMA rows are seeded current. A completed attempt is stamped current even when no local art exists, preventing repeated work on genuinely artless files. Use **Settings → Library → Refresh Metadata** to force a complete folder re-read or pick up a newly-added folder image when the audio file mtime did not change.

**Serving.** `tracks.art_hash` stores the local result (`NULL` = not yet processed, `''` = no local art, otherwise the hash). `GET /api/art` serves:
- `?hash=<hash>&size=<256|640|1024>` → streams the pre-encoded AVIF directly, `Cache-Control: immutable`.
- `?pathB64=<path>` → serves cached local art, performs live normalized embedded/folder resolution when the row is stale or the cache was cleared, then consults the configured album-art provider and redirects through the allowlisted external-image proxy. If every source fails it returns `404`.

The client requests a hash URL when `art_hash` is known (see `buildTrackUrls`) and appends `&size=` per context via `AlbumArt` (grids 256, detail hero 640, now-playing up to 1024). Artless tracks retain the path-addressed URL, so the same provider result reaches album views, player controls, queues, Media Session, Cast, and OpenSubsonic `getCoverArt` instead of being implemented separately in each UI component. Local artwork always wins.

**Operational notes.** `ART_CACHE_DIR` is a derived cache — safe to delete; it rebuilds on the next scan or Refresh Metadata, so it does not need to be backed up. `sharp` is a runtime dependency (native module); `npm ci` installs the prebuilt binary on Linux automatically.

## Audio Processing (Planned)
- **Web Audio API**: The audio element is wrapped with an `AudioContext` (initialized on first user interaction). Currently routes `MediaElementAudioSourceNode` → `destination`.
- **Future Chain**: `MediaElementAudioSourceNode` → `GainNode` (Volume) → `BiquadFilterNodes` (EQ) → `AnalyserNode` (Visualizer) → `destination`.
- **Cross-fade**: Orchestrated by dual gain-node ramps during track transitions.
- **Gapless**: Leveraging `audioContext.currentTime` and look-ahead buffering to schedule next track starts with micro-second precision.

## WMA Support
- **Transcoding**: WMA files are transcoded to AAC on-the-fly via the HLS pipeline (same as other formats when quality < source bitrate)
- **Legacy fallback**: Direct WMA → MP3 pipe streaming is preserved in the `/api/stream` legacy endpoint
- **Format Detection**: File extension-based MIME type mapping in `MIME_TYPES` record
- **Artwork recovery**: Malformed `WM/Picture` offsets, missing JPEG SOI/JFIF prefixes, multiple embedded pictures, and conventional Windows Media folder artwork are normalized through the shared album-art resolver
