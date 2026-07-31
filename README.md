# GK Watcher

GK Watcher is a tool built on Vite and React for automatically scraping Japanese websites, mostly for GKs, and emailing you when new items are found.

To start run start.sh or start.bat depending on whether you are using Linux or Windows. Access the client via localhost:5173.

The server runs on port 3000 and is started automatically when you run the client.

## Operations

Use Node 20 (`.nvmrc`) and immutable installs:

```bash
cd server && npm ci
cd ../client && npm ci && npm run build
```

Browser-backed scrapers require Chromium or Google Chrome on the host. Set `PUPPETEER_EXECUTABLE_PATH` when it is not installed in a standard location; Puppeteer browser downloads are intentionally disabled for reproducible deployments.

Ntfy defaults to `https://ntfy.sh`. Self-hosted public endpoints must be explicitly listed in `NTFY_ALLOWED_ORIGINS` as a comma-separated set of HTTPS origins.

`GET /api/health` is the deployment readiness endpoint. PM2 runs the application and an online SQLite backup at 03:00 daily through `ecosystem.config.js`.

Backups default to `server/data/backups` with mode `0600`. Set `GKWATCH_BACKUP_DIR` to a protected off-host mount and `GKWATCH_BACKUP_KEY` to a base64-encoded 32-byte key for encrypted backups. Verify a restore artifact without replacing production data:

```bash
cd server
npm run backup
npm run backup:verify -- /path/to/gkwatch-backup.db.enc
```

Configure `GKWATCH_BACKUP_RETENTION_DAYS` from 1 to 3650; the default is 14 days. Restore checks must be run periodically against an isolated copy before relying on a backup policy.
