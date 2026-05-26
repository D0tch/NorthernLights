# Aurora Media Server

Aurora is a self-hosted web music player for local libraries. It scans folders on your server, streams your files through a React web app, enriches metadata from external providers, and builds library-aware AI playlists from your own collection.

The project lives in the `NorthernLights` repository, but the product name in the app is Aurora Media Server / NorthernLights Media Player.

## Status

Current release: `1.0.0-rc.3`

Aurora is ready for early self-hosted production use. Expect fast iteration and occasional migrations before the first stable `1.0.0` release.

## Screenshots

The Hub is the listener's home: daily mixes, artist radios, and the time-of-day daylist all live here.

![Hub](docs/screenshots/NorthernLights-hub.png)

![Hub — alternative layout](docs/screenshots/NorthernLights-hub2.png)

Album, artist, and library views — full-bleed artwork, popular local tracks, and upcoming shows where available.

![Album detail](docs/screenshots/NorthernLights-singleAlbum.png)

![Artist detail](docs/screenshots/NorthernLights-artist.png)

![Albums grid](docs/screenshots/NorthernLights-albums.png)

Playlists — manual, prompt-generated, and system-generated all live alongside each other.

![Playlists](docs/screenshots/NorthernLights-playlists.png)

Settings cover library scanning, metadata providers, playback, LLM credentials, and user administration.

![Settings](docs/screenshots/NorthernLights-settings.png)

## Quick Install

Ubuntu and Debian users can install the runtime dependencies, clone the repository, build the app, create the Python ML environment, and start Aurora under PM2 with:

```bash
curl -fsSL https://raw.githubusercontent.com/destroptor-spec/NorthernLights/main/install.sh | bash
```

Open the URL printed by the installer, create the database from the setup screen, then create the first admin account.

For manual deployment, reverse proxy setup, backups, and update procedures, see [docs/production_guide.md](docs/production_guide.md).

## Core Features

- Local-library streaming for MP3, FLAC, OGG/Opus, M4A/AAC, WAV, and FFmpeg-backed WMA.
- Browser, mobile, PWA, and Chromecast playback through HLS.
- Multi-user accounts with JWT authentication and invite-based registration.
- PostgreSQL plus pgvector storage, managed through Podman or Docker.
- Three-phase scanning: filesystem walk, metadata extraction, and audio analysis.
- MusiCNN 8D acoustic vectors plus 1280D Discogs-EffNet embeddings for similarity.
- MusicBrainz genre ontology import and local genre mapping.
- AI Hub playlists and prompt-generated playlists using local library health, genre paths, acoustic similarity, EffNet embeddings, diversity controls, and banned-genre handling.
- External metadata integrations for Last.fm, Genius, MusicBrainz, ListenBrainz, and JamBase where configured.
- Artist detail pages with popular local tracks, upcoming shows, hero artwork, and similar artists.
- Playlist management with manual playlists, durable prompt-generated playlists, and transient Hub playlists.
- Light/dark themes, route-based navigation, global search, queue editing, loved tracks, scrobbling, and local audio output selection.

## Requirements

Minimum recommended server:

- Ubuntu 22.04+ or Debian 12+ for the one-line installer.
- Node.js 20 or newer.
- FFmpeg and ffprobe.
- Podman or Docker for PostgreSQL/pgvector.
- 4 GB RAM minimum, 8 GB+ recommended for larger libraries.
- 4 GB swap recommended on small VPS instances.
- Enough disk for your music, PostgreSQL data, MusicBrainz import work files, and HLS temp files.

The installer uses `uv` to create a Python 3.11 virtual environment for Essentia TensorFlow analysis. Manual installs should do the same.

## Manual Setup

```bash
git clone https://github.com/destroptor-spec/NorthernLights.git
cd NorthernLights
cp .env.example .env
npm ci
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
uv venv --python 3.11 .venv
uv pip install essentia-tensorflow
npm run build
npx tsx server/index.ts
```

Then open `http://localhost:3001`.

The setup flow will let you create the PostgreSQL container if one is not already running.

## Configuration

Copy `.env.example` to `.env` and review at least:

- `PORT`: default `3001`.
- `ALLOWED_ORIGINS`: comma-separated browser origins allowed by CORS.
- `DB_*`: PostgreSQL connection settings.
- `DB_CONTAINER_NAME` and `DB_DATA_DIR`: managed database container settings.
- `MBDB_WORK_DIR`: temporary MusicBrainz import workspace.
- `SERVER_URL`: public base URL for OAuth callbacks when behind a reverse proxy.
- `CAST_RECEIVER_APP_ID` and `CAST_RECEIVER_ORIGIN`: optional Chromecast custom receiver settings.

Most provider keys and AI settings can also be configured from the app settings UI.

## Production

Recommended production shape:

1. Run Aurora as an unprivileged user.
2. Keep PostgreSQL data outside the repo or in a backed-up `DB_DATA_DIR`.
3. Run the Node server with PM2 or systemd.
4. Put Nginx, Caddy, or another TLS reverse proxy in front of port `3001`.
5. Set `SERVER_URL` and `ALLOWED_ORIGINS` to your public HTTPS URL.
6. Back up PostgreSQL data and `.env`.

See [docs/production_guide.md](docs/production_guide.md) for concrete commands.

## Updating

```bash
cd ~/NorthernLights
git pull
npm ci
uv pip install essentia-tensorflow
npm run build
pm2 restart aurora
```

If you use the installer defaults, the PM2 process may be named `aurora` or `northernlights` depending on when it was installed. Check with `pm2 list`.

## Development

```bash
npm install
npm run dev
```

Development runs Vite and the Express server concurrently. Production builds are served by the Express server from `dist/`.

Before submitting changes:

```bash
npx tsc --noEmit
npx vite build
```

[![Buy Me a Coffee at ko-fi.com](https://storage.ko-fi.com/cdn/kofi6.png?v=6)](https://ko-fi.com/X8X51YLFS8)

## License

Copyright (c) 2026 Andreas Destroptor-spec

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
