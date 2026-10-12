# Brewlog

Brewlog is a batch-first homebrewing PWA. Each brewery has its own SQLite database. The browser keeps a persistent local CR-SQLite database for offline use and syncs changes with a TypeScript server on your machine. The server also has a separate, private SQLite database for login and brewery ownership. APIs and database tables still use `workspace` as the internal name for a brewery.

## Run locally

Requirements: Node.js 22 or later, Yarn 1.x, and a modern browser with IndexedDB and WebAssembly. The current automated browser check uses Chromium; Firefox and Safari still need device testing.

```sh
yarn install
yarn setup:sqlite
yarn dev
```

Open the app and choose **Create account**. Each new account gets a private brewery named Homebrew and can add more from the brewery switcher. Usernames are case insensitive; passwords must be at least 8 characters. An `.env` file is optional if you want to change the data directory or port; see `.env.example`.

This starts the API on port 3001 and Vite on port 5173. Open `http://localhost:5173`. Vite proxies API requests to the server. The browser stores its local database in IndexedDB through CR-SQLite's persistent virtual file system. After a successful sign-in, the same device can reopen its local batches while the server is unavailable.

For a production build:

```sh
yarn build
yarn start
```

The server serves the built PWA and API together on port 3001. Point your Cloudflare Tunnel at that port using one HTTPS hostname. Keep `data/` and the downloaded `vendor/crsqlite.so` on the host; `data/` holds the auth, catalog, and brewery databases. Back up the SQLite database files consistently, including their WAL files, or use SQLite's backup API. Do not copy a live database file alone as a backup.

## Current workflow

- Create separate breweries for your home setup and commercial operation.
- Create batches directly or copy a recipe's actions into a new batch.
- Add one batch action with optional timing, then record it or mark it skipped. Recording updates the action's current quantity and other details; there is no separate planned-versus-actual action.
- Record additions, measurements, equipment settings, transfers, packaging, milestones, notes, inventory entries, equipment calibrations, and batch photos. Search the shared catalog when adding equipment or inventory, or create a custom item. Equipment calibration fields match the instrument type. Deleting used equipment hides it from active lists while preserving historical event references.
- Continue working offline; the app syncs on reconnect and at regular intervals.
- Use the Ant Design left sidebar to open batches, recipes, inventory, and equipment, with recent item links under each section. Each section URL shows an index and each item has its own detail page. Equipment and inventory indexes use separate tables per type. The default Homebrew brewery uses root URLs such as `/equipment` and `/batch/:id`; other breweries use `/brewery/:slug/equipment` and `/brewery/:slug/batch/:id`.
- Open `/me` from the avatar to upload an account avatar, choose preferred units, change your password, adjust automatic sync, or sign out. The sync icon there starts a manual sync and shows when sync last succeeded.
- Use the same navigation on phones, tablets, and desktop screens. On phones, it opens in a left Drawer.

This proof of concept does not migrate brewery databases from older schemas. Schema 7 needs a fresh brewery database and fresh browser storage; existing schema 6 databases are left untouched and rejected with an explanatory error.

Accounts can register and each account can own multiple private breweries. Sync covers each full brewery; sharing, per-batch permissions and filtered sync are later targets. RAPT Pill ingestion and server Web Push reminders are specified in [DESIGN.md](DESIGN.md) but are not wired up yet. A separate read-only `data/catalog.sqlite` holds example equipment and inventory entries. Signed-in devices keep a separate local SQLite copy for offline search; copying an entry creates an independent brewery-owned item. Catalog edits on the server require incrementing `catalog_meta.version` so devices download the new snapshot.

## Checks

```sh
yarn typecheck
yarn test
yarn smoke:browser
```

The browser smoke check expects a running `yarn dev` server and a local Chromium executable. It registers a fresh test account by default. Override its URL, username, password, or Chromium path with `BREWLOG_TEST_URL`, `BREWLOG_TEST_USERNAME`, `BREWLOG_TEST_PASSWORD`, and `CHROMIUM_PATH`.
