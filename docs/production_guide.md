# Aurora Production Guide

This guide covers a first production deployment of Aurora Media Server from the `NorthernLights` repository.

## Deployment Model

Aurora is one Node.js service plus a PostgreSQL/pgvector database:

- Express serves the API and built React app on `PORT` 3001 by default.
- PostgreSQL can be managed by Aurora through Podman or Docker.
- FFmpeg handles decoding, transcoding, HLS, and analysis input.
- A Python 3.11 virtual environment runs Essentia TensorFlow extraction for MusiCNN and Discogs-EffNet.
- A reverse proxy should terminate HTTPS in front of Aurora for public access.

## Server Requirements

Recommended baseline:

| Library Size | RAM | CPU | Notes |
|---|---:|---:|---|
| Under 2,000 tracks | 4 GB | 2 threads | Add swap before analysis. |
| 2,000 - 10,000 tracks | 8 GB | 4 threads | Good fit for balanced scanning. |
| 10,000+ tracks | 16 GB+ | 8 threads | Use lower analysis concurrency on small VPS hosts. |

Use at least 4 GB swap on small servers:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Automated Install

Ubuntu/Debian:

```bash
curl -fsSL https://raw.githubusercontent.com/destroptor-spec/NorthernLights/main/install.sh | bash
```

The installer:

- installs Node.js 20, FFmpeg, Podman or Docker, PM2, `uv`, and archive utilities;
- clones or updates `~/NorthernLights`;
- creates `.env` if missing;
- builds the frontend;
- creates `.venv` with `essentia-tensorflow`;
- starts Aurora with PM2.

After it finishes, open the printed URL and complete the setup wizard.

## Manual Install

Install system packages:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git ffmpeg bzip2 tar openssl podman
```

Install Node.js 20 from NodeSource if your distribution package is older:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Clone and build:

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
```

Start once:

```bash
npx tsx server/index.ts
```

Open `http://server-ip:3001` and create the database and admin account.

## Environment

Important `.env` values:

```bash
PORT=3001
ALLOWED_ORIGINS=https://music.example.com
SERVER_URL=https://music.example.com

DB_USER=musicuser
DB_PASSWORD=change-this
DB_HOST=localhost
DB_PORT=5432
DB_NAME=musicdb
DB_CONTAINER_NAME=music-postgres
DB_DATA_DIR=/home/aurora/aurora-data/postgres
MBDB_WORK_DIR=/home/aurora/aurora-data/mbdb
```

Notes:

- `ALLOWED_ORIGINS` must include the browser origin that loads the app.
- `SERVER_URL` should be the public HTTPS base URL when using Last.fm or MusicBrainz OAuth.
- Keep `DB_DATA_DIR` and `MBDB_WORK_DIR` on a disk with enough free space.
- Keep `.env` private. It contains secrets.

## Running With PM2

```bash
sudo npm install -g pm2
pm2 start "npx tsx server/index.ts" --name aurora
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup`, then run `pm2 save` again.

Useful commands:

```bash
pm2 logs aurora
pm2 restart aurora
pm2 status
```

## Running With systemd

PM2 is easiest for the one-line install. If you prefer systemd, create a user service:

```ini
[Unit]
Description=Aurora Media Server
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/aurora/NorthernLights
ExecStart=/usr/bin/env npx tsx server/index.ts
Restart=on-failure
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

Then:

```bash
systemctl --user daemon-reload
systemctl --user enable --now aurora.service
systemctl --user status aurora.service
```

For boot without an active SSH session:

```bash
sudo loginctl enable-linger aurora
```

## Reverse Proxy

Example Nginx site:

```nginx
server {
    server_name music.example.com;

    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
    }
}
```

Then set:

```bash
ALLOWED_ORIGINS=https://music.example.com
SERVER_URL=https://music.example.com
```

Use Certbot, Caddy, or your platform's TLS tooling to provide HTTPS.

## First Launch Checklist

1. Open Aurora in the browser.
2. Create or start the PostgreSQL container from the setup screen.
3. Create the first admin account.
4. Add music folders in Settings -> Library.
5. Scan the library.
6. Download/check ML models in Settings -> Database if needed.
7. Import MusicBrainz Database if you want hierarchy-aware genre mapping.
8. Run Genre Matrix after the first scan.
9. Configure LLM provider settings if you want AI playlists.
10. Configure Last.fm, Genius, MusicBrainz, ListenBrainz, JamBase, and Chromecast as needed.

## Updates

```bash
cd ~/NorthernLights
git pull
npm ci
uv pip install essentia-tensorflow
npm run build
pm2 restart aurora
```

If your PM2 process is named `northernlights`, replace `aurora` with `northernlights`.

## Backups

Back up:

- `.env`
- `DB_DATA_DIR`
- any manually hosted Chromecast receiver files
- optional `logs/` if you need diagnostics

At minimum, stop Aurora before copying a file-backed database volume:

```bash
pm2 stop aurora
tar -czf aurora-postgres-backup.tgz /home/aurora/aurora-data/postgres
pm2 start aurora
```

For larger installs, prefer PostgreSQL-native backups from inside the container.

## Operations Notes

- Audio analysis is CPU and memory heavy. Start with Balanced or Background CPU usage in Settings.
- Chromecast uses AAC-in-HLS for reliability.
- Hub LLM playlists refresh only for active users on login or Hub access. Prompt-generated playlists are durable.
- MusicBrainz import needs temporary disk space and can take a while.
- If scans fail on unusual filenames, check FFmpeg availability and `logs/`.

## Troubleshooting

Check service logs:

```bash
pm2 logs aurora
```

Check database container:

```bash
podman ps -a
podman logs music-postgres
```

Common issues:

- Blank page after deploy: run `npm run build` and restart the server.
- Login/OAuth callback mismatch: check `SERVER_URL` and `ALLOWED_ORIGINS`.
- Database unavailable: start or recreate the container from the setup/database screen, or check Podman/Docker permissions.
- Analysis returns simulated features: check `.venv`, `essentia-tensorflow`, FFmpeg, and model download status.
- Cast fails from another network: make sure the Chromecast can reach your HTTPS domain and any custom receiver origin is allowed.
