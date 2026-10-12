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

At most one brewery per account can have a null slug and use root routes such as `/batches`. A brewery with a slug uses `/brewery/:slug/batches`, regardless of creation order. Item routes follow the same prefix. Slugs live in the auth DB and can be changed in Settings independently of display names. Deleting the root brewery does not promote another brewery to root URLs.

### Implementation phases

1. **Initial:** Open account registration, one or more private workspace DBs per account, full local copies on that account's devices, authenticated whole-workspace sync, batches and plans, and the first useful event types. Add RAPT ingestion and reminders as the batch workflow matures.
2. **Later:** Multiple accounts, workspace membership, per-batch read and read/write grants, filtered sync into following DBs, server-side enforcement of incoming writes, and revocation behavior. Complete a filtered-sync proof of concept before exposing any shared batch.

Keep IDs, provenance, and batch ownership explicit from the start so the later phase has the information it needs. Initial authentication still protects a machine exposed through Cloudflare Tunnel; it does not imply a full permission system.

## Data conventions

- Use client-generated NanoIDs for distributed row identities. IDs are opaque; no meaning or ordering is inferred from them.
- Store timestamps as UTC Unix **seconds**. `actual_at` is when something happened according to its source or user; `received_at` is when the server first accepted it. Neither timestamp is the CR-SQLite sync cursor.
- Record `created_by_account_id` for human actions and an integration/source identity for machine actions. Keep the raw external reading ID where available for deduplication. A manual measurement records its instrument as well as its human creator.
- Preserve a quantity's entered numeric value and **unit**. The app converts compatible quantities to canonical values for calculations and display. This preserves distinctions such as `5 US gal`, `19 L`, `1 tablet`, and `2 packets`, and avoids forcing additions or inventory into an inappropriate universal unit. Canonical calculation units include seconds, liters, and degrees Celsius. Unit conversion and precision rules belong in shared client logic.
- A batch action is an editable working record. Correct its values in place; recipe templates remain independent. Separate readings from sensors are separate observations. A recorded `actual_at` takes precedence over `skipped_at` if offline peers set both.
- An event's `batch_id` and identity are immutable. This also makes authorization of changes and deletions tractable.

## Workspace data model

The names below are proposed logical tables. A migration can refine names and split payloads without changing the relationships.

### Batches and actions

| Table | Main fields and role |
| --- | --- |
| `batches` | `id`, name, description, status, timestamps. This is the root for the batch timeline. The current UI uses `created_at` as the batch start time (T0); no separate `started` event is required. |
| `recipes` / `recipe_types` | Name, description, and beer/wine/mead/cider type. Reusable editable plans, independent of batches. New beer recipes seed mash and boil ranges, chill to a target temperature, transfer to fermenter, yeast pitching, and packaging. Wine, mead, and cider seed yeast pitching and packaging. Packaging is anchored to yeast pitching with an editable estimated interval (21 days for beer, 28 for cider, 60 for wine and mead). Container details are optional in a plan and required when packaging is recorded. |
| `recipe_events` | Planned actions or milestones in a recipe, including type-specific planned details, order, and timing rule. Editing or deleting a recipe does not rewrite existing batches. Deleting a recipe also deletes its type and template actions. |
| `batch_events` | One row per batch action. Recipe events are copied here when a batch is created. The row has its title, kind, timing anchor and offset, editable action details, optional `actual_at` and `skipped_at`, creator/recorder/source, and optional `received_at`. Actions added during the batch use the same table. |
| `event_ends` | Optional actual end timestamp for a ranged event, keyed by its event ID. A range can be in progress until this row exists. |

An action is pending until it has `actual_at` or `skipped_at`. If offline peers independently record and skip it, `actual_at` wins in the UI and inventory calculations. Editing a pending or completed action changes its current quantity, duration, target, or other details. The batch does not preserve earlier versions of its plan. A recipe retains its own template values.

An action stores `offset_seconds` from batch start, or `anchor_event_id` plus `offset_seconds` from another action. Temperature and pressure control actions can be timed ranges, except post boil chill, which has a target temperature and records when the target is reached. A pending range stores its target `duration_seconds` in its details. Anchored actions can refer to the start or end of a range with `anchor_point`. Until an anchor happens, the UI estimates its time from that action's timing rule; a recorded start or end supersedes the estimate. Recipe anchors are remapped to copied batch actions. New actions do not use absolute planned times. A skipped anchor still supplies its estimated time.

Recipes and batches use the same event timeline and add menu. The batch view adds recording, skipping, actual readings, and photos. Both timelines show a batch-start group even when it has no additions. Deleting a recipe event leaves its dependents intact: direct dependents lose their anchor and keep their calculated offset from batch start; later descendants retain their anchors.

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
| `transfers` | Optional destination vessel equipment ID and transferred quantity with unit. Transfer is a batch action, not a bare milestone. Recipe and pending batch actions can select the destination before recording; recording can confirm or change it. Referenced vessel equipment is archived when removed from the active equipment list. The old source-vessel column remains unused for existing databases. |
| `packaging` | Container type/size, count, packaged quantity, and optional inventory item consumed. |
| `boil_finished` | Legacy milestone retained for existing data. New plans use a timed boil range and anchor to its start or end. |
| `notes` | Free-text observations that do not fit a physical measurement or action. |

Action details are a single editable set of values. Pending additions keep their quantity in `details_json`; recording moves it to the `additions` row used for inventory and later corrections. The quantity is not retained as a separate planned value. A pending measurement can exist without a measured value; its value, uncertainty, and instrument are filled in when recorded.

#### Temperature control intervals

The next temperature-control event for the **same batch**, of any mode and on any equipment, implicitly ends the preceding setting. We do not model simultaneous heater and chiller settings for one batch. An explicit end is stored in `event_ends` and the temperature-control payload. Query the next setting by `(batch_id, actual_at, id)` for an implicit end. A late or concurrent setting then changes the derived interval without rewriting a prior event. Since those keys live on `batch_events`, index that table on `(batch_id, event_type, actual_at, id)`.

If one fridge serves several batches, record the relevant temperature-control event in **each batch**. These are duplicate batch observations of one physical setting, not a new shared control-session entity. Joining a batch to an already running fridge records when that batch began experiencing its setting.

### Equipment and calibration

| Table | Main fields and role |
| --- | --- |
| `equipment` | Brewery-owned physical items: kettle, controller, chiller, fermenter, fridge, hydrometer, pH meter, etc. May retain a source catalog model ID and a copied specification. Vessels may store capacity in liters; measuring instruments may store a minimum, maximum, and measurement unit instead. Fermenters use one equipment kind, with optional built-in temperature control and maximum working pressure in kPa. External temperature control remains separate equipment. Temperature and pressure setting actions record what was done during a batch. Consumable bottles belong in inventory. |
| `equipment_archives` | Hides equipment used by events from active lists while retaining the referenced equipment and calibration rows for history. Unused equipment can be deleted outright. |
| `equipment_calibrations` | Legacy immutable records retained for existing measurements and sync compatibility. New calibration edits update the equipment specification. |
| `equipment_characterization_observations` | Legacy boil observations retained in existing schemas for sync compatibility. New calibrations do not write this table. |

Measurements store **corrected values** and per-reading uncertainty. Equipment displays its current calibration values alongside capacity and other settings. Temperature-reading equipment stores one offset in °C, calculated as reference temperature minus equipment reading. Other instruments store their current reference and observed values in the equipment specification. Recalibration replaces these values rather than creating a history record. Existing calibration IDs remain attached to historical measurements. New batch measurements ask for a corrected value and do not automatically apply the current equipment calibration.

Electric kettles and all-in-one systems store rated power and one calibrated heat-loss value in watts in their equipment specification. A steady-boil test derives the heat loss as power used minus the energy needed to evaporate the measured volume. The test inputs are not retained. Predicted boil-off at a chosen power is `max(0, power - heat loss) / 600.7` liters per hour, using water properties near 100 °C from [NISTIR 5078](https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir5078.pdf). Recalibration replaces the value. The approximation assumes average heater power and a steady boil; ambient conditions and wort composition are not modeled.

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
3. Define tie handling for same-second events and the reminder behavior for actions anchored to skipped actions.
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
