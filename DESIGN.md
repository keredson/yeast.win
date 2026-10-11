# Brewlog design

Status: working design, 2026-10-11. This records the decisions made so far and the parts that still need validation. It is a product and data model design, not an executable SQL migration.

## Purpose

Brewlog is an offline-capable PWA for recording **what happened to a batch and when**. A recipe is a reusable plan for events; a batch is the actual brewing record. The primary screen is a batch timeline that shows planned work, completed work, measurements, sensor data, and photos together.

The app should work for a homebrewer with one operation and for an account that also runs a separate brewery. It should support multiple contributors, selective batch sharing, equipment calibration, inventory, RAPT Pill readings, and reminders.

## Architecture

- **Client:** React PWA with SQLite in the browser. Reads, timelines, calculations, charts, and analysis run on the device. Writes work offline and sync later. A service worker caches the app shell; it is not the database authority.
- **UI:** One responsive PWA must work on mobile, tablet, and desktop. Use Ant Design components where they fit, with layouts and touch targets adapted to each viewport. Prototype the batch timeline and event-entry flow at all three sizes. Component selection does not affect the data model.
- **Server:** A small Node.js service written in TypeScript runs on our own machine. It handles login, whole-workspace sync, sensor ingestion, push scheduling, and backups. It does not run UI analysis queries. SQLite is the server storage engine. The same TypeScript definitions can describe event payloads and sync messages on client and server; runtime input validation is still required.
- **Exposure:** `cloudflared` publishes the app and API on a stable HTTPS hostname through Cloudflare Tunnel. Prefer one origin for the PWA and API. No Cloudflare Worker is required for each sync request. If the machine or tunnel is down, the installed PWA remains usable locally, but sync, sensor ingestion, and server-triggered reminders pause.
- **Replication:** Evaluate `cr-sqlite` CRRs for mergeable tables and implement the browser/server transport over HTTPS, with WebSockets if useful. Start with whole-workspace sync. The transport belongs to Brewlog; CR-SQLite does not provide application authorization policies.

### Database boundaries

| Database | Location | Sync | Purpose |
| --- | --- | --- | --- |
| Auth DB | Server only | Never synced as a database to browsers | Login/session data, account avatars, preferred units, integration credentials, push subscriptions, and server jobs. Later: workspace memberships and sharing grants. |
| Shared catalog DB | Server and devices | Read-only to clients | Common equipment and inventory templates. The server stores `catalog.sqlite`; devices keep a separate persistent SQLite copy and refresh it by version. Copying a template creates an independent brewery item. Templates include common ingredients, supplies, vessels, and instruments. |
| Workspace DB | Server and authorized devices | Whole-DB sync initially; filtered batch sync later | Batches, plans, actual events, equipment instances, calibrations, inventory, and photos. One DB represents a brewery, not an account or a batch. |

The UI calls each operation a **brewery**; APIs and database tables retain `workspace` as their internal name. An account can own several private breweries. A shared batch stays in its brewery's workspace DB. Batch sharing, follower databases, and workspace membership are **later implementation targets**; they do not block the initial whole-workspace app.

The first Homebrew brewery is the default at root routes such as `/batches`. Additional breweries have stable account-scoped slugs at `/brewery/:slug/batches`. Item routes follow the same prefix. Slugs live in the auth DB and remain stable if display names change.

### Implementation phases

1. **Initial:** Open account registration, one or more private workspace DBs per account, full local copies on that account's devices, authenticated whole-workspace sync, batches and plans, and the first useful event types. Add RAPT ingestion and reminders as the batch workflow matures.
2. **Later:** Multiple accounts, workspace membership, per-batch read and read/write grants, filtered sync into following DBs, server-side enforcement of incoming writes, and revocation behavior. Complete a filtered-sync proof of concept before exposing any shared batch.

Keep IDs, provenance, and batch ownership explicit from the start so the later phase has the information it needs. Initial authentication still protects a machine exposed through Cloudflare Tunnel; it does not imply a full permission system.

## Data conventions

- Use client-generated NanoIDs for distributed row identities. IDs are opaque; no meaning or ordering is inferred from them.
- Store timestamps as UTC Unix **seconds**. `actual_at` is when something happened according to its source or user; `received_at` is when the server first accepted it. Neither timestamp is the CR-SQLite sync cursor.
- Record `created_by_account_id` for human actions and an integration/source identity for machine actions. Keep the raw external reading ID where available for deduplication. A manual measurement records its instrument as well as its human creator.
- Preserve a quantity's entered numeric value and **unit**. The app converts compatible quantities to canonical values for calculations and display. This preserves distinctions such as `5 US gal`, `19 L`, `1 tablet`, and `2 packets`, and avoids forcing additions or inventory into an inappropriate universal unit. Canonical calculation units include seconds, liters, and degrees Celsius. Unit conversion and precision rules belong in shared client logic.
- Prefer new event rows for corrections or competing real-world observations so the history and authors remain visible. A deliberately corrected measurement can point to the event it supersedes. Do not rely on CR-SQLite's cell merge to resolve competing physical facts.
- An event's `batch_id` and identity are immutable. This also makes authorization of changes and deletions tractable.

## Workspace data model

The names below are proposed logical tables. A migration can refine names and split payloads without changing the relationships.

### Batches and plans

| Table | Main fields and role |
| --- | --- |
| `batches` | `id`, name, description, status, timestamps. This is the root for the batch timeline. The current UI uses `created_at` as the batch start time (T0); no separate `started` event is required. |
| `recipes` | `id`, name, description, version/metadata. Reusable editable plans, independent of batches. |
| `recipe_events` | Planned actions or milestones in a recipe, including type-specific planned details, order, and timing rule. Editing a recipe does not rewrite existing batches. |
| `batch_planned_events` | Snapshot of recipe events copied when a batch is created with an optional recipe, plus plans added specifically to that batch. These rows are treated as immutable historical plans; a revised plan supersedes an earlier plan rather than silently editing it. |
| `batch_events` | Actual events: `id`, `batch_id`, `event_type`, `actual_at`, optional `planned_event_id`, creator/source, `received_at`, and optional supersession metadata. Type-specific rows below carry their payloads. |

An actual event can fulfill a planned event, be an unplanned action, or record that a planned event was **skipped** (`event_type = 'skipped'`, with `planned_event_id`). A skip has its own actual timestamp and creator; it is not a nullable `skipped_at` on the plan. More than one actual event may refer to the same plan. That preserves conflicting offline actions for review instead of erasing one of them.

A new plan stores `offset_seconds` from batch start, or `anchor_event_id` plus `offset_seconds` from another event. The default is zero seconds from start, so additions at the beginning group naturally. The anchor identifies a meaningful planned milestone whose corresponding actual event supplies the real-world time; `boil_finished` is one example. Until an anchor has an actual result, the UI estimates its time from the anchor's plan. Recipe anchors are remapped to copied batch plans. Legacy `planned_at` timestamps remain readable, but the UI does not create new absolute planned times. What to do with a skipped or conflicting anchor remains a product rule to define.

### Actual event payloads

`batch_events` holds the shared event identity and provenance. Payload tables hold data specific to each action. One event can have multiple compatible payload rows: a single RAPT Pill reading creates one `batch_events` row and both gravity and temperature measurement rows.

| Table / kind | Main payload |
| --- | --- |
| `additions` | Ingredient or inventory item, quantity, unit, and optional lot. Yeast and oxygen additions use this kind. |
| `temperature_measurements` | Corrected value, unit, uncertainty, measuring equipment, calibration record, and source. |
| `ph_measurements` | Corrected value, uncertainty, meter, calibration, and source. |
| `gravity_measurements` | Corrected value, scale/unit, uncertainty, instrument, calibration, and source. |
| `volume_measurements` | Corrected value, unit, uncertainty, instrument or method, and location/vessel when relevant. |
| `pressure_measurements` | Corrected value, unit, uncertainty, instrument, and calibration. |
| `carbonation_measurements` | Corrected value, unit, uncertainty, instrument or method. Planned carbonation targets can be represented separately as planned measurements/settings. |
| `dissolved_oxygen_measurements` | Corrected value, unit, uncertainty, instrument, and calibration. Adding oxygen remains an `addition`. |
| `temperature_control_events` | Controlled equipment, mode/context, target temperature and/or power setting, and optional `ended_at`. The same kind covers mashing, boiling, chilling, fermentation, and serving. |
| `pressure_control_events` | Equipment and pressure setpoint. A setpoint is distinct from a pressure measurement. |
| `transfers` | From/to vessel or destination and transferred quantity with unit. Transfer is a batch action, not a bare milestone. |
| `packaging` | Container type/size, count, packaged quantity, and optional inventory item consumed. |
| `boil_finished` | An actual milestone with no invented temperature-setting end anchor. Its timestamp can resolve downstream plans. |
| `notes` | Free-text observations that do not fit a physical measurement or action. |

Planned events need the fields necessary to express their intended action or target. They need not duplicate every actual-only field such as calibration, uncertainty, or receipt time. A planned measurement is valid even if no measurement is eventually taken.

#### Temperature control intervals

The next temperature-control event for the **same batch**, of any mode and on any equipment, implicitly ends the preceding setting. We do not model simultaneous heater and chiller settings for one batch. Keep `ended_at` null for an implicit end; set it only for an explicit stop without a replacement. Query the next setting by `(batch_id, actual_at, id)` to derive the effective end. A late or concurrent setting then changes the derived interval without rewriting a prior event. Since those keys live on `batch_events`, index that table on `(batch_id, event_type, actual_at, id)`.

If one fridge serves several batches, record the relevant temperature-control event in **each batch**. These are duplicate batch observations of one physical setting, not a new shared control-session entity. Joining a batch to an already running fridge records when that batch began experiencing its setting.

### Equipment and calibration

| Table | Main fields and role |
| --- | --- |
| `equipment` | Workspace-owned physical items: kettle, controller, chiller, fermenter, fridge, hydrometer, pH meter, etc. May retain a source catalog model ID and a copied specification, including capacity in liters. Consumable bottles belong in inventory. |
| `equipment_archives` | Hides equipment used by events from active lists while retaining the referenced equipment and calibration rows for history. Unused equipment can be deleted outright. |
| `equipment_calibrations` | Immutable records of calibration parameters, method, effective time, and author. Measurements link to the calibration used at capture time. |
| `equipment_characterization_observations` | Observed power, temperatures, volumes, time, and evaporation/heat-loss data used to fit kettle behavior. |

Measurements store **corrected values** and per-reading uncertainty. The calibration record explains how the correction was obtained; it is not edited after use. Different instruments can therefore have different accuracy, and old readings retain the calibration that applied then. Boil-off modeling should work across wattages and account for temperature-dependent heat loss, rather than storing one boil-off rate or assuming wattage alone determines it. The exact fitting model is a later analysis decision.

### Inventory

| Table | Main fields and role |
| --- | --- |
| `inventory_items` | Distinct stock identities, such as a specific grain variety, yeast, nutrient, bottle, or other supply; category and default display unit. |
| `inventory_item_specs` | Deprecated compatibility table from schema version 3. New inventory items do not use it; capacity belongs to equipment. |
| `inventory_purchases` | Quantity and unit added, date, supplier/lot/cost when known. |
| `inventory_counts` | A dated assertion that a quantity of an item was physically on hand. This anchors later balance calculations. |

Inventory is a ledger, not a mutable `quantity_on_hand` field. Additions and packaging can consume inventory directly via their linked item and quantity; they should not generate a second, independently editable "used" movement. Balance after a count is that count plus purchases and other receipts minus linked uses after it. Conversions require compatible dimensions; counts, packets, and mass are not silently mixed. Photos may attach to inventory items as well as batches.

### Photos

`photos` stores image metadata and the full image BLOB **inside the workspace DB**, with links to batches, batch events, or inventory items. New batch photo uploads create a `photo` batch event and attach the image to it, so the image appears in the timeline. Older images without an event appear there using their photo timestamp. Set an ingestion limit of about 5 MB per compressed image, verify MIME/type and dimensions, and strip unneeded metadata. This keeps photo replication in the same sync and permission path as the rest of the batch. Small thumbnails are disposable device-local cache entries generated from the full image; they are not separately synced.

## Sync and authorization

Initially, sync all CRR changes between an account's device and each private workspace DB it opens. `crsql_changes.db_version` is the replication cursor; `received_at` is for provenance and ingest ordering, not for completeness of sync. Retain source site IDs and use idempotent application/retry. Transport 64-bit SQLite cursor values as BigInt or decimal strings rather than assuming every value fits a JavaScript `number`. HTTPS request/response is sufficient for correctness; WebSockets can reduce latency. Authentication is required, but there is no per-batch permission filtering in the initial implementation.

### Later: sharing and filtered sync

For a batch follower, the server must authorize **each incoming and outgoing change**. It may scan a workspace changeset and filter in memory, then stream authorized changes, provided benchmarks show this is acceptable. Every child row, photo, and delete must be mapped to its batch even if a deletion change carries only an opaque row ID. Keep the mapping/tombstone information needed for that decision, and avoid syncing unrelated recipes, inventory, private equipment details, or other batches as accidental dependencies. Batch membership in a row cannot be mutable without reworking this scheme.

Read-only followers get a read-only UI. The server rejects their writes regardless of what someone does to a local SQLite file. Write access to a batch requires server validation of the entire proposed change, including referenced rows. Revoking a grant stops future sync, but cannot erase data a device already downloaded while authorized; local following DBs should be purged on the next contact.

**Later-phase feasibility gate:** upstream CR-SQLite documents partial CRR sync as possible with its primitives but unsupported and not advised, and says its change indexes are not optimized for multi-tenant filtering. Before implementing sharing, build a focused proof of concept: two batches in one workspace, a follower for only one, updates and deletes in parent/child rows, photos, permission changes, concurrent offline edits, and reconnects. If safe filtered sync proves too fragile, revisit the replication boundary rather than assuming CR-SQLite supplies row-level security.

CRR tables also cannot rely on checked foreign keys, non-primary-key uniqueness, or cross-column checks. Validate relationships on local writes and at the server sync boundary, and audit/repair orphaned data. The server-only auth DB can use ordinary SQLite constraints.

## RAPT and reminders

- Bind a RAPT Pill identity to a batch for a defined time range. Preserve the external reading ID and source timestamp, deduplicate retries, and record the server receipt time.
- One Pill reading becomes one actual measurement event with linked gravity and temperature values. Other sources, including manual hydrometers and refractometers, use the same measurement model and identify their own instrument/calibration.
- Choose callback ingestion if RAPT offers a suitable authenticated callback; otherwise poll its API from the server. Do not assume an undocumented new API feature is available. If using a callback, publish only the required authenticated endpoint through the tunnel.
- The server evaluates planned due times and sends Web Push reminders such as a stepped nutrient feeding. The open PWA can also show local in-app reminders. Notification delivery is best effort; browser/platform support and machine availability affect it. The timeline remains the record of whether the action actually happened or was skipped.

## Operational needs

- Run the app/API and `cloudflared` as services on the host. Keep the SQLite files on persistent local storage; back up all workspace DBs, the auth DB, and integration credentials. Test restores.
- Serve the app over HTTPS on a stable hostname so installation, service workers, and push can work. The domain and tunnel are routing; the host supplies the compute and disk.
- Keep server endpoints authenticated and rate limited. Validate uploaded changes, images, and sensor readings before merging into a workspace DB.
- Treat browser persistence as a prototype gate: verify the selected SQLite WASM build, storage backend, and recovery behavior on target browsers. Also test BLOB round trips across browser and native SQLite before relying on photo sync.

## Decisions still open

1. **Later sharing phase:** Prove CR-SQLite partial batch sync, especially delete authorization, dependent rows, photos, and revocation. Decide whether following DBs are per source workspace or per grant.
2. Select and test browser SQLite persistence (for example OPFS versus the library's IndexedDB-backed path), including large databases and interrupted writes.
3. Define correction/supersession UI, tie handling for same-second events, and how an anchored plan resolves if its anchor is skipped or fulfilled more than once.
4. Finalize measurement units and uncertainty representations for gravity, carbonation, dissolved oxygen, and pressure; define dimension-safe conversion rules for inventory.
5. Verify the current RAPT integration path and notification behavior on the browsers we intend to support.
6. Test the batch timeline and event-entry flow at mobile, tablet, and desktop widths, including touch use and keyboard use.

## References for implementation constraints

- [CR-SQLite networking background and change indexing](https://vlcn.io/docs/cr-sqlite/networking/background)
- [CR-SQLite partial CRR sync status](https://vlcn.io/docs/cr-sqlite/networking/partial-crr-sync)
- [CR-SQLite constraint limitations](https://vlcn.io/docs/cr-sqlite/constraints)
- [CR-SQLite change API](https://vlcn.io/docs/cr-sqlite/api-methods/crsql_changes)
- [CR-SQLite in Node.js with a loadable SQLite extension](https://vlcn.io/docs/cr-sqlite/js/nodejs)
- [Cloudflare Tunnel published applications](https://developers.cloudflare.com/tunnel/concepts/routing/)
