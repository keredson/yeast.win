# Yeast.Win!

Yeast.Win! is a batch-first fermentation notebook for experiments. Recipes are optional: you can start a batch directly and record what you used and what happened as you go. Each brewery has its own SQLite database. The browser keeps a persistent local CR-SQLite database for offline use and syncs changes with a TypeScript server on your machine. The server also has a separate, private SQLite database for login and brewery ownership. APIs and database tables still use `workspace` as the internal name for a brewery.

## Run locally

Requirements: Node.js 22 or later, Yarn 1.x, and a modern browser with IndexedDB and WebAssembly. The current automated browser check uses Chromium; Firefox and Safari still need device testing.

```sh
yarn install
yarn setup:sqlite
yarn dev
```

Open the app and choose **Create account**. Each new account gets a private brewery named Homebrew. Create, rename, change the URL slug, or delete breweries in **Settings**; the selector at the top of the sidebar switches between them. Usernames are case insensitive; passwords must be at least 8 characters. An `.env` file is optional if you want to change the data directory; see `.env.example`.

This starts the API on `.brewlog-api.sock` in this checkout and Vite on the first free port from 5173. Open the URL printed by Vite. Vite proxies API requests through the checkout's Unix socket. The browser stores its local database in IndexedDB through CR-SQLite's persistent virtual file system. After a successful sign-in, the same device can reopen its local batches while the server is unavailable.

To run a second development copy, run `yarn dev` from another checkout. Each checkout has its own API socket, and Vite chooses a free web port. For separate accounts and breweries, give the second copy its own data directory:

```sh
BREWLOG_DATA_DIR=./data-second yarn dev
```

`BREWLOG_PORT` and `BREWLOG_HOST` apply to `yarn start`, which serves the built app and API together over TCP. Set `BREWLOG_SOCKET` to serve production over a Unix socket instead. Development always uses the checkout socket. Without a separate `BREWLOG_DATA_DIR`, both copies use the same server databases.

For a production build:

```sh
yarn build
yarn start
```

The server serves the built PWA and API together on port 3001 by default, or on `BREWLOG_SOCKET` when configured. Point your Cloudflare Tunnel at that endpoint using one HTTPS hostname. Keep `data/` and the downloaded `vendor/crsqlite.so` on the host; `data/` holds the auth, catalog, and brewery databases. Back up the SQLite database files consistently, including their WAL files, or use SQLite's backup API. Do not copy a live database file alone as a backup.

For a production installation with a dedicated runtime account, socket-activated GitHub deployment hook,
systemd service, and Cloudflare Tunnel, see [deploy/README.md](deploy/README.md). The one-time host setup is
run with `make provision`; subsequent local releases can be tested with `make deploy`.

On that host, production is the catalog source of truth. With the development server stopped, run
`make catalog-pull-production` to refresh `data/catalog.sqlite` from a consistent production snapshot.
After making and reviewing local catalog edits, run `make catalog-push-production` to back up both copies,
briefly stop the production service, promote the local catalog, restart, and health-check it. Normal Git
deployments never copy catalog data.

## Current workflow

- Create separate breweries for your home setup and commercial operation.
- Create batches directly or copy a recipe's actions into a new batch.
- Add one batch action with optional timing, then record it or mark it skipped. Recording updates the action's current quantity and other details; there is no separate planned-versus-actual action.
- Record additions, measurements, equipment settings, transfers, packaging, milestones, notes, inventory entries, equipment calibrations, and batch photos. Search the shared catalog when adding equipment or inventory, or create a custom item. Equipment calibration fields match the instrument type. Deleting used equipment hides it from active lists while preserving historical event references.
- Continue working offline; the app syncs on reconnect and at regular intervals.
- Use the dark left sidebar to switch breweries and open batches, recipes, inventory, equipment, and settings, with recent item links under each record section and the account menu at the bottom. Each section URL shows an index and each item has its own detail page. Equipment and inventory indexes use separate tables per type. The brewery with a null slug uses root URLs such as `/equipment` and `/batch/:id`; breweries with slugs use `/brewery/:slug/equipment` and `/brewery/:slug/batch/:id`. Deleting the root brewery does not change another brewery’s URLs.
- Open `/settings` from the sidebar to choose preferred units, manage breweries, upload an account avatar, change your password, or configure the RAPT Pill integration. Set each brewery’s default batch size and mash efficiency in its create or edit dialog. The RAPT webhook URL is created when you open the integration settings; deleting the integration revokes the URL and clears its Pill assignments. Each brewery row shows its last sync time and has a sync icon; brewery deletion is in its edit dialog. Open the avatar menu to log out.
- Use the same navigation on phones, tablets, and desktop screens. On phones, it opens in a left Drawer.

Accounts can register and each account can own multiple private breweries. Sync covers each full brewery; sharing, per-batch permissions and filtered sync are later targets. RAPT Pill webhook ingestion is available; server Web Push reminders remain a later target. A separate `data/catalog.sqlite` holds shared equipment and inventory entries. Signed-in devices keep a separate local CR-SQLite copy for offline search; the server sends catalog changes one way using a cursor. Copying an entry creates an independent brewery-owned item. Server catalog edits are tracked by CR-SQLite and do not require a manual version bump.

## RAPT Pill webhook

In **Settings → RAPT Pill**, generate a private webhook URL. It must use a public HTTPS host that reaches this server; a localhost URL works only for local tests. In your RAPT account, create a Custom Web Hook with method POST, paste the URL, select the Pills to send, and use the JSON payload shown in Settings. After RAPT sends a reading, refresh Settings to see the discovered Pill and assign it to a batch in any of your breweries. Unassigned readings identify the Pill but do not create batch events.

The URL belongs to the Yeast.Win! account, while each Pill's assignment chooses a brewery and batch. The server stores the connection, devices, and assignment history in its private auth database. An assigned reading creates one batch measurement event with gravity in SG and temperature in °C. The server uses the RAPT device ID and source timestamp to ignore repeated deliveries. Rotating the URL immediately invalidates the previous one; update the URL in RAPT afterward. This webhook setup requires manual configuration in RAPT and does not sign in to the RAPT API.

## Checks

```sh
yarn typecheck
yarn test
yarn smoke:browser
```

The browser smoke check expects a running `yarn dev` server and a local Chromium executable. It registers a fresh test account by default. Override its URL, username, password, or Chromium path with `BREWLOG_TEST_URL`, `BREWLOG_TEST_USERNAME`, `BREWLOG_TEST_PASSWORD`, and `CHROMIUM_PATH`.
