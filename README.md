# Brewlog

Brewlog is a batch-first homebrewing PWA. Each workspace has its own SQLite database. The browser keeps a persistent local CR-SQLite database for offline use and syncs changes with a TypeScript server on your machine. The server also has a separate, private SQLite database for login and workspace ownership.

## Run locally

Requirements: Node.js 22 or later, Yarn 1.x, and a modern browser with IndexedDB and WebAssembly. The current automated browser check uses Chromium; Firefox and Safari still need device testing.

```sh
yarn install
yarn setup:sqlite
yarn dev
```

Open the app and choose **Create account**. Each new account gets a private Homebrew workspace and can add more workspaces. Usernames are case insensitive; passwords must be at least 8 characters. An `.env` file is optional if you want to change the data directory or port; see `.env.example`.

This starts the API on port 3001 and Vite on port 5173. Open `http://localhost:5173`. Vite proxies API requests to the server. The browser stores its local database in IndexedDB through CR-SQLite's persistent virtual file system. After a successful sign-in, the same device can reopen its local batches while the server is unavailable.

For a production build:

```sh
yarn build
yarn start
```

The server serves the built PWA and API together on port 3001. Point your Cloudflare Tunnel at that port using one HTTPS hostname. Keep `data/` and the downloaded `vendor/crsqlite.so` on the host; `data/` holds the auth and workspace databases. Back up the SQLite database files consistently, including their WAL files, or use SQLite's backup API. Do not copy a live database file alone as a backup.

## Current workflow

- Create separate workspaces for homebrewing and a brewery.
- Create batches directly or copy a recipe's planned events into a new batch.
- Plan fixed-time or anchored events, then record actual events or explicitly skip a plan.
- Record additions, measurements, equipment settings, transfers, packaging, milestones, notes, inventory entries, equipment calibrations, and batch photos.
- Continue working offline; the app syncs on reconnect and at regular intervals.
- Use the same responsive interface on phones, tablets, and desktop screens.

Accounts can register and each account can own multiple private workspaces. Sync covers each full workspace; sharing, per-batch permissions and filtered sync are later targets. RAPT Pill ingestion and server Web Push reminders are specified in [DESIGN.md](DESIGN.md) but are not wired up yet. The equipment catalog is also planned; workspace-owned equipment can already be entered manually.

## Checks

```sh
yarn typecheck
yarn test
yarn smoke:browser
```

The browser smoke check expects a running `yarn dev` server and a local Chromium executable. It registers a fresh test account by default. Override its URL, username, password, or Chromium path with `BREWLOG_TEST_URL`, `BREWLOG_TEST_USERNAME`, `BREWLOG_TEST_PASSWORD`, and `CHROMIUM_PATH`.
