# GK Watcher

GK Watcher is a tool built on Vite and React for automatically scraping Japanese websites, mostly for GKs, and emailing you when new items are found.

Run `deploy.sh` or `deploy.bat` once to install dependencies, run checks, and build the client. Start with an explicit mode:

```bash
./start.sh --production
./start.sh --dev
```

On Windows, use `start.bat --production` or `start.bat --dev`. With no mode flag, the launcher preserves the legacy behavior: it uses production mode when a client build exists and development mode otherwise. The launcher now waits for the backend and frontend to become healthy and stops the other process if either one fails.

Use `update.sh` or `update.bat` from a Git checkout to pull and verify the newest version. Update scripts re-run themselves after pulling so newly downloaded update logic takes effect immediately. Downloaded ZIP copies cannot update in place; clone the repository to use updates.

The server runs on port 3000 and is started automatically when you run the client.

## Operations

Use Node 20 (`.nvmrc`) and immutable installs:

```bash
cd server && npm ci
cd ../client && npm ci && npm run build
```

Browser-backed scrapers require Chrome, Chromium, or Microsoft Edge on the host. Set `PUPPETEER_EXECUTABLE_PATH` when it is not installed in a standard location; Puppeteer browser downloads are intentionally disabled for reproducible deployments.

Ntfy defaults to `https://ntfy.sh`. Self-hosted public endpoints must be explicitly listed in `NTFY_ALLOWED_ORIGINS` as a comma-separated set of HTTPS origins.

`GET /api/health` is the deployment readiness endpoint. PM2 runs the application and an online SQLite backup at 03:00 daily through `ecosystem.config.js`.

`deploy_remote.sh` is the canonical PM2 deployment entry point and uses the `foundry` SSH alias by default. It refuses to overwrite remote working-tree changes, creates a database backup, performs a fast-forward update, and restores the prior revision if setup or readiness checks fail. Override its defaults with `GKWATCH_REMOTE_HOST`, `GKWATCH_REMOTE_KEY`, and `GKWATCH_REMOTE_DIR`.

When TLS terminates at a reverse proxy, forward the original request metadata to the Node server. Cookie-authenticated writes use these headers for same-origin enforcement:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;
```

Backups default to `server/data/backups` with mode `0600`. Set `GKWATCH_BACKUP_DIR` to a protected off-host mount and `GKWATCH_BACKUP_KEY` to a base64-encoded 32-byte key for encrypted backups. Verify a restore artifact without replacing production data:

```bash
cd server
npm run backup
npm run backup:verify -- /path/to/gkwatch-backup.db.enc
```

Configure `GKWATCH_BACKUP_RETENTION_DAYS` from 1 to 3650; the default is 14 days. Restore checks must be run periodically against an isolated copy before relying on a backup policy.
