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

### Form conventions

Across all modals and forms, mark required fields with Ant Design's red asterisk. Leave optional field labels plain; do not append “(optional)” or include “optional” in a unit label. The absence of the asterisk already communicates that a field can be left blank. Keep the same labels in accessible field names and browser checks.

### Database boundaries

| Database | Location | Sync | Purpose |
| --- | --- | --- | --- |
| Auth DB | Server only | Never synced as a database to browsers | Login/session data, account avatars, preferred units, integration credentials, push subscriptions, and server jobs. Later: workspace memberships and sharing grants. |
| Shared catalog DB | Server and devices | One-way CR-SQLite changes from server to devices | Common equipment models and inventory templates. The server stores `catalog.sqlite`; devices keep a separate persistent CR-SQLite copy and apply only changes after their last server cursor. Workspace connections attach the local catalog as `catalog`, allowing SQL joins across the two files. A brewery item may reference a catalog model while retaining its own identity and settings. Templates include common ingredients, supplies, vessels, and instruments. |
| Workspace DB | Server and authorized devices | Whole-DB sync initially; filtered batch sync later | Batches, plans, actual events, equipment instances, calibrations, inventory, and photos. One DB represents a brewery, not an account or a batch. |

The UI calls each operation a **brewery**; APIs and database tables retain `workspace` as their internal name. An account can own several private breweries. A shared batch stays in its brewery's workspace DB. Batch sharing, follower databases, and workspace membership are **later implementation targets**; they do not block the initial whole-workspace app.

At most one brewery per account can have a null slug and use root routes such as `/batches`. A brewery with a slug uses `/brewery/:slug/batches`, regardless of creation order. Item routes follow the same prefix. Slugs live in the auth DB and can be changed in Settings independently of display names. Deleting the root brewery does not promote another brewery to root URLs.

Within a brewery, equipment, inventory, recipe, and location URL segments are derived from the visible records. Names, Stock IDs, and stored slugs provide the readable base. If two resulting segments collide, both gain their full, case-sensitive internal IDs; the check repeats if a suffixed segment matches another readable base. The same merged rows therefore produce distinct routes on every replica, even if two offline edits chose the same Stock ID or slug. These URLs may change after sync or edits; internal IDs remain the record identity. The auth DB separately enforces brewery-slug uniqueness on the server.

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
- This is pre-release software. Every schema change still upgrades the database schema in place. Preserve compatible tables, rows, and column values, including unrelated batches, recipes, and inventory. Migrate data when its mapping to the new schema is straightforward, such as a renamed column or values moved into a typed table. Losing specific obsolete or incompatible values is acceptable when backfilling them is difficult or impractical; do not reset the whole workspace as a shortcut.
- Prefer explicit columns and related tables for application data. Columns holding arbitrary JSON are discouraged and require explicit user approval before they are added. Existing JSON columns are implementation details to revisit, not a precedent for new ones.

## Workspace data model

The names below are proposed logical tables. A migration can refine names and split payloads without changing the relationships.

### Batches and actions

| Table | Main fields and role |
| --- | --- |
| `batches` | `id`, name, description, status, timestamps. This is the root for the batch timeline. The current UI uses `created_at` as the batch start time (T0); no separate `started` event is required. |
| `batch_origins` | Links a batch copied from a previous batch to that source. The new batch owns independent action rows. |
| `recipes` / `recipe_types` | Name, description, and beer/wine/mead/cider type. Reusable editable plans, independent of batches. New beer recipes seed mash and boil ranges, chill to a target temperature, transfer to fermenter, yeast pitching, and packaging. Wine, mead, and cider seed yeast pitching and packaging. Packaging is anchored to yeast pitching with an editable estimated interval (21 days for beer, 28 for cider, 60 for wine and mead). Container details are optional in a plan and required when packaging is recorded. |
| `recipe_events` | Planned actions or milestones in a recipe, with shared timing columns and order. Type-specific values live in recipe payload tables. Editing or deleting a recipe does not rewrite existing batches. Deleting a recipe also deletes its type and template actions. |
| `batch_events` | One row per batch action. Recipe events are copied here when a batch is created. The row has its title, kind, timing columns, optional `actual_at` and `skipped_at`, creator/recorder/source, and optional `received_at`. Type-specific values live in batch payload tables. Actions added during the batch use the same tables. |
| `event_ends` | Optional actual end timestamp for a ranged event, keyed by its event ID. A range can be in progress until this row exists. |

An action is pending until it has `actual_at` or `skipped_at`. If offline peers independently record and skip it, `actual_at` wins in the UI and inventory calculations. Editing a pending or completed action changes its current quantity, duration, target, or other details. The batch does not preserve earlier versions of its plan. A recipe retains its own template values.

New batches may start empty, with a beer/wine/mead/cider action template, from a recipe, or from a previous batch. Recipe and batch creation use the same type templates; choosing a template for a batch creates no recipe. Repeating a batch copies repeatable actions and planned measurement reminders with fresh IDs, turning recorded times and durations into timing rules relative to the new batch start. Skipped actions, sensor readings, notes, photos, and equipment use history are left behind. Equipment can be remapped to available physical units, and ingredients can be linked to current stock rather than silently retaining a prior lot. The old batch remains unchanged.

An action stores `offset_seconds` from batch start, or `anchor_event_id` plus `offset_seconds` from another action. Temperature and pressure control actions can be timed ranges, except post boil chill, which has a target temperature and records when the target is reached. A pending range stores its target `duration_seconds` in an event column. Anchored actions can refer to the start or end of a range with `anchor_point`. Until an anchor happens, the UI estimates its time from that action's timing rule; a recorded start or end supersedes the estimate. Recipe anchors are remapped to copied batch actions. New actions do not use absolute planned times. A skipped anchor still supplies its estimated time.

Recipes and batches use the same event timeline and add menu. The batch view adds recording, skipping, actual readings, and photos. Both timelines show a batch-start group even when it has no additions. Deleting a recipe event leaves its dependents intact: direct dependents lose their anchor and keep their calculated offset from batch start; later descendants retain their anchors.

### Recipe import and future calculations

Import BeerXML or Brewfather JSON on the device. Keep the original file bytes, format, filename, import time, and hash in the brewery database; link each created recipe to its source record. A file with multiple recipes prompts for which recipes to import. No general recipe preview is needed. Before writing, show the distinct imported ingredients and let the user map each to an existing inventory item, create a new item, or leave it unlinked. A newly created inventory item has no stock balance: recipe quantity is not a purchase or count. Write the selected recipes, actions, mappings, and source links together, without the normal new-recipe seed actions.

Persist source inputs used by the recipe, not calculated predictions. These include ingredient amounts and properties at the time of import (for example hop alpha acid and grain yield/color), water and salt additions or water-profile inputs, process times and temperatures, target volumes, equipment assumptions, and the efficiency assumption. An inventory link supplies current ingredient defaults to a recipe; copy the values used into a batch when it starts so later inventory edits cannot change that batch's history. The original file retains unmapped fields and is the source for a future reimport. A measured OG or FG belongs to a batch measurement if importing actual batch history; an exported estimated OG or FG is a calculated result and is not stored as recipe source data.

The imported file remains intact in `recipe_import_sources.content`. Editable or calculated inputs have typed columns in `recipe_inputs` and `recipe_event_inputs`; their effective values are copied into typed `batch_recipe_inputs` and `batch_event_inputs` when the batch starts. Source-only fields remain available in the original file rather than being duplicated as loose key/value maps.

The recipe stores its target volume into the fermenter. Grain, hop, and yeast properties resolve from catalog supply defaults, brewery supply overrides, and lot overrides. The effective values are copied into batch event inputs when a batch starts or a particular lot is recorded. Mash efficiency, grain absorption, mash dead space, and kettle retention are equipment assumptions; the recipe's grain-drain transfer names the mash equipment instead of duplicating its efficiency. If no efficiency is set, a recent batch with recorded grain additions, collected wort volume, and pre-boil gravity can supply an estimate. Batch event inputs preserve the value used when the batch started. A beer recipe uses a transfer titled “Drain grain” after the mash, including for an all-in-one kettle: pulling its basket transfers wort internally to the kettle. Its recorded quantity is collected wort volume, and a gravity measurement after it allows actual mash efficiency to be calculated. An optional separate volume measurement can be used when the transfer quantity is unavailable.
When an imported ingredient is mapped to an existing inventory item, that item's current properties are the calculation defaults; the imported properties remain in the source inputs for provenance.
For a grain with no recorded extract yield, the recipe calculator uses an explicitly labeled app estimate by grain class (base 78%, kilned 75%, caramel 70%, roasted 65%, flaked 70%, other 75%). A recorded brewery or catalog yield wins, followed by an imported recipe value; the app estimate is last. Missing color remains unknown, so an SRM estimate can stay unavailable even when OG is calculated. Hop alpha and yeast attenuation are not guessed from a general product name when lot or product values vary. The catalog retains sourced product specifications and does not persist calculated recipe outcomes. Legacy generic grain, hop, and yeast catalog entries are retired; linked brewery supplies remain as local custom records, and Crystal 60's previous color value is carried into those brewery records.
BeerXML's `EFFICIENCY` is brewhouse efficiency, so its imported value remains source data and is not assigned to the mash equipment's efficiency.

Calculate results on the device from stored inputs. Initial calculation list, in approximate implementation order:

1. Volume progression: mash/strike/sparge water, pre-boil and post-boil volume, boil-off, and vessel losses.
2. Predicted original gravity from fermentable yield, amounts, efficiency, and volume.
3. Predicted final gravity and ABV from gravity and yeast attenuation assumptions; label FG as an estimate.
4. Bitterness from hop alpha acid, use, timing, wort conditions, and a selected utilization method.
5. Color from fermentable color, amount, and volume.
6. Mash pH and water adjustments from water composition, grist, and salt/acid additions.
7. Carbonation/priming from target CO₂, temperature, volume, and packaging method.

Do not persist these predicted values. Store chosen calculation methods and user-supplied assumptions as inputs; recompute when inputs change. A result may be cached locally for display but is disposable. Imported source-only fields need explicit schema or UI support before they become editable; the event form edits only fields represented in the typed action tables.

The recipe Details section computes batch size, expected OG, FG, ABV, and estimated beer color locally. Batch size means target volume at the start of fermentation. Every recipe stores a positive batch size. New recipes prefill it from the brewery default or a 5 US gal (18.92705892 L) app default, and the value is saved with the recipe so later default changes do not affect it. Imports preserve a stated batch size; imports without one and older recipes with no size receive the brewery or app default and retain an assumed-source marker until the size is edited. Brewery batch size and mash efficiency defaults are edited under Settings → Recipe calculations. OG uses grain extract yield and an efficiency selected in this order: mash equipment model, recent measured batch with that equipment, imported recipe brewhouse efficiency, brewery default mash efficiency, then a 75% app mash efficiency assumption. Mash efficiency also accounts for post-boil wort retained by linked equipment; imported brewhouse efficiency applies directly to batch size. FG uses one yeast's attenuation; ABV follows from OG and FG. Color uses fermentable Lovibond values and the Morey approximation. Every estimate has a tooltip naming the values and their sources, including the fallback selected; unavailable estimates also name missing inputs. Adjunct extract, fruit/honey sugar, bitterness, and other calculations above still need their own models and inputs.

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

Action details are a single editable set of values. Recipe actions have type-specific planned payload tables. Batch actions use their type-specific payload tables while pending and when recorded; recording fills in or corrects the same row. Shared timing fields and instructions are columns on `recipe_events` and `batch_events`. A pending measurement can exist without a measured value; its target is stored separately from the observed value, uncertainty, and instrument filled in when recorded. Event `details_json` columns have been removed; schema upgrades keep compatible event columns and may discard values that existed only in the removed JSON field.

#### Temperature control intervals

The next temperature-control event for the **same batch**, of any mode and on any equipment, implicitly ends the preceding setting. We do not model simultaneous heater and chiller settings for one batch. An explicit end is stored in `event_ends` and the temperature-control payload. Query the next setting by `(batch_id, actual_at, id)` for an implicit end. A late or concurrent setting then changes the derived interval without rewriting a prior event. Since those keys live on `batch_events`, index that table on `(batch_id, event_type, actual_at, id)`.

If one fridge serves several batches, record the relevant temperature-control event in **each batch**. These are duplicate batch observations of one physical setting, not a new shared control-session entity. Joining a batch to an already running fridge records when that batch began experiencing its setting.

### Equipment and calibration

| Table | Main fields and role |
| --- | --- |
| `equipment_models` | Brewery-owned equipment definitions, including custom models and models linked to the shared catalog. Holds name, kind, catalog model ID, capability defaults, mash assumptions, and optional fixed post-boil wort retained in liters. Recipes refer to these model IDs. |
| `brewery_process_defaults` | Legacy aggregate wort loss retained for existing databases, but no longer used in estimates or shown in settings. |
| `equipment` | Individual physical units. Each row has a stable ID, model ID, name, optional stock ID, slug, `added_at`, and `removed_at`. Ten identical fermenters are ten rows linked to one model. Batch actions and measurements refer to unit IDs. Consumable bottles belong in inventory. |
| `equipment_locations` | Optional current location for each physical equipment unit, keyed by its unit ID. Models have no location. The link is replicated and is cleared when a unit is removed. Existing units start unassigned after upgrade. |
| `equipment_liquid_containment`, `equipment_pressure_rating`, `equipment_heating`, `equipment_cooling`, `equipment_temperature_control`, `equipment_post_boil_losses` | Optional capability and assumption rows keyed by the physical item. Their typed columns hold capacity, pressure rating, heater power, rated heat removal, minimum/maximum controllable temperature, and fixed post-boil wort retained. Presence of a heating or cooling row implies that capability; temperature control has no heat/cool flags. The temperature setpoint belongs to a recipe or batch action. |
| `equipment_measurement_channels` | One row per sensed quantity, such as temperature or specific gravity. Range, physical unit, and measurement scale are separate columns; SG is a scale, not a unit. A device with two sensors has two rows. |
| `equipment_boil_calibration`, `equipment_temperature_calibration`, `equipment_measurement_calibration_points`, `equipment_mash_assumptions` | Current calibration and mash assumptions for the physical item. Recalibration replaces values; there is no calibration history table. |
| `equipment_model_boil_characterization` | Optional brewery model default for heat loss at a steady boil, in watts. It overrides the catalog model value for all units of that model without unit calibrations. |
| `equipment_archives` | Legacy archive timestamps migrated to `equipment.removed_at`. Removing a unit retains its row and references for history. |

The Equipment index and an inventory product's Lots and locations table follow the same display convention: show a single row directly when there is one location, and expand parent rows into location rows when there are several. Both tables use a separate Location column and a vertical actions menu on each row. The Equipment index summarizes unit counts by model and location; individual stock IDs and calibrations appear on the model and unit pages. Inventory rows instead summarize quantities by lot and location. Changes to either table's hierarchy, location display, or action placement should be considered for the other table, even when their implementations are separate. Deleting from an equipment model row removes all its physical units but retains the model definition; deleting from a location row removes all units of that model at that location. Removed units retain batch history and calibration records.

The catalog has `manufacturers` for manufacturer name and website URL. Catalog `equipment_models` refer to manufacturers by name and store model name, kind, and product URL. The replicated `model_images` table stores product image and thumbnail bytes with separate MIME types; `manufacturer_logos` stores logo bytes with a MIME type. Bundled product photos and thumbnails are JPEG; bundled logos are PNG to preserve transparency. During the version 19 upgrade, previously bundled WebP bytes are replaced by the matching JPEG or PNG bytes only when their hashes match the former defaults. Edited images retain their bytes and MIME types. These media tables remain in the catalog database, so their images are available offline after sync. Image source URLs are not stored in the catalog or runtime code. Optional `model_liquid_containment`, `model_pressure_rating`, `model_heating`, `model_cooling`, `model_temperature_control`, and `model_measurement_channels` rows describe capabilities. `model_boil_characterization` holds an optional catalog model heat-loss default in watts for boiling equipment. The cooling power is rated **heat removal** in watts, not electrical consumption. These tables model capabilities rather than device categories, so one model can combine a vessel, heating, cooling, control, and multiple measurement channels.

For a unit linked to a catalog model through a workspace model, each non-null unit capability value overrides its workspace model and then its catalog model. A custom workspace model has no catalog reference. Workspace rows can add a capability absent from the catalog model. There is no disable override. Recipes use workspace model defaults; batches choose a physical unit when started. If exactly one unit matches a recipe model, it can be selected automatically. Assignment and release are batch events, with release time stored on the interval end row.

Equipment import forms show fields for the model's actual capability rows, including every measurement channel. Equipment detail and edit forms derive their capability settings from the effective catalog and workspace rows, not from the item's `kind`; an all-in-one model without a cooling row must not show cooling settings. Users can add a missing capability to a physical item later, which inserts a workspace capability row and makes its settings editable. Equipment kinds may provide initial presets when defining an item without a catalog model, but those presets must not decide which capability fields appear after creation.

Browser workspace connections create temporary `effective_equipment` and `effective_measurement_channels` SQL views over the attached catalog and workspace tables. These views implement inheritance with `COALESCE` and keep model changes visible after catalog sync without copying model attributes into the workspace database. The catalog remains independently writable by its one-way sync path; attaching it does not make catalog changes part of workspace replication.

Measurements store **corrected values** and per-reading uncertainty. Equipment displays its current calibration values alongside capacity and other settings. Temperature-reading equipment stores one offset in °C, calculated as reference temperature minus equipment reading. Other instruments store their current reference and observed values in typed calibration rows. Recalibration replaces these values rather than creating a history record. New batch measurements ask for a corrected value and do not automatically apply the current equipment calibration.

Electric kettles and all-in-one systems have rated power in their heating capability. Their effective boil heat loss is the first non-null value from the physical unit's `equipment_boil_calibration`, the brewery model's `equipment_model_boil_characterization`, and the catalog model's `model_boil_characterization`, in that order. Zero watts is a valid value; null means inherit. A unit calibration is keyed by stable equipment ID, not its optional stock ID. Changing a brewery model default affects only units without their own calibration; clearing an override resumes inheritance. Recipe model queries resolve the brewery model or catalog default; an assigned batch unit can resolve all three levels. The equipment page displays the effective value's source. A steady-boil test derives unit heat loss as power used minus the energy needed to evaporate the measured volume. The test inputs are not retained. Predicted boil-off at a chosen power is `max(0, power - heat loss) / 600.7` liters per hour, using water properties near 100 °C from [NISTIR 5078](https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir5078.pdf). Recalibration replaces the value. The approximation assumes average heater power and a steady boil; ambient conditions and wort composition are not modeled. Catalog values require a defensible source and are absent when unknown.

Recipe gravity estimates sum fixed post-boil wort retained by distinct equipment models linked to boil or chill actions and by equipment linked to the transfer to the fermenter. Recipe transfer links refer to models; batch transfer links refer to physical units. A batch uses the physical unit's value when set, otherwise its brewery model value. Unset values contribute zero; an explicit zero remains distinguishable from an unset assumption. Mash/grain-drain losses are separate and never part of this sum. Equipment not linked to these actions does not contribute. Historical brewery, recipe, and batch aggregate loss values remain in legacy columns so upgrades preserve them, but are no longer used or edited. The earlier kettle-retention migration also carries forward old equipment values into the new model or physical-unit loss fields.

### Inventory

| Table | Main fields and role |
| --- | --- |
| Catalog `supplies` | Shared names, categories, and units. Grain, hop, and yeast products use manufacturer-specific identities; generic packaging, chemicals, and other commodity supplies remain available. Typed specification tables hold known defaults. |
| Catalog `supply_products`, `supply_grain_classes`, `supply_images` | Manufacturer and one product information URL per supply, grain class for estimate fallbacks, and copied product images with MIME types. Product images sync with the catalog for offline use; an absent image means no verified matching manufacturer image was bundled. |
| Brewery `supplies` | Brewery-owned supply definitions. An optional catalog link provides inherited defaults; custom supplies need no catalog entry. Recipes link here without choosing a physical lot. |
| `supply_media` | Optional brewery product image and product URL, keyed by supply ID. Unset values inherit from the linked catalog product. A custom supply may have its own media without a catalog link. Images replicate with the brewery DB and are limited to 5 MB. |
| `supply_grain_specs`, `supply_hop_specs`, `supply_yeast_specs` | Optional brewery overrides for grain class, yield and color, hop alpha acid and form, or yeast attenuation. Null inherits the catalog value. |
| `supply_lots` | Physical purchase or production lots for a brewery supply, with optional lot code, crop year, and best-before date. |
| `lot_grain_specs`, `lot_hop_specs`, `lot_yeast_specs` | Optional lot-specific overrides. A recorded batch addition can select a stock row and snapshot its effective lot properties. |
| `inventory_items` | Stock bucket for one lot at one location. Its stable ID remains the target of the quantity ledger, batch uses, and photos. Existing rows migrate into supply and lot records without changing those IDs. |
| `inventory_ingredient_properties` | Legacy properties retained for compatibility with older stock rows. Migration copies them to supply and lot specification tables. |
| `inventory_item_specs` | Deprecated compatibility table from schema version 3. New inventory items do not use it; capacity belongs to equipment. |
| `inventory_purchases` | Quantity and unit added, date, supplier/lot/cost when known. |
| `inventory_counts` | A dated assertion that a quantity of an item was physically on hand. This anchors later balance calculations. |
| `inventory_locations` / `inventory_location_slugs` | Hierarchical physical storage places with stable brewery-local URL slugs. A location can be renamed or moved without changing its URL. |

Inventory is a ledger, not a mutable `quantity_on_hand` field. A supply can have multiple lots, and each lot can have stock at multiple locations. Additions and packaging can consume inventory directly via their linked stock bucket and quantity; they should not generate a second, independently editable "used" movement. Balance after a count is that count plus purchases and other receipts minus linked uses after it. Conversions require compatible dimensions; counts, packets, and mass are not silently mixed. Photos may attach to inventory stock as well as batches.

Locations have their own top-level navigation below Equipment. `/locations` visualizes the hierarchy and unassigned stock and equipment; `/location/:slug` shows a place's child locations, direct stock grouped by category, and equipment units. Named breweries prefix these paths with `/brewery/:brewerySlug`. Location settings manage name, slug, parent, and deletion; a location with stock, equipment, or children must be emptied first. Inventory and equipment location pickers retain a contextual “New location…” option. Equipment placement is a current association; movement history is not yet tracked.
The Locations index leaves empty sections blank and puts its Add location action after the content; it does not use an empty-state illustration or “No locations yet” message.

### Photos

`photos` stores image metadata and the full image BLOB **inside the workspace DB**, with links to batches, batch events, or inventory items. New batch photo uploads create a `photo` batch event and attach the image to it, so the image appears in the timeline. Older images without an event appear there using their photo timestamp. Set an ingestion limit of about 5 MB per compressed image, verify MIME/type and dimensions, and strip unneeded metadata. This keeps photo replication in the same sync and permission path as the rest of the batch. Small thumbnails are disposable device-local cache entries generated from the full image; they are not separately synced.

## Sync and authorization

Initially, sync all CRR changes between an account's device and each private workspace DB it opens. `crsql_changes.db_version` is the replication cursor; `received_at` is for provenance and ingest ordering, not for completeness of sync. Retain source site IDs and use idempotent application/retry. Transport 64-bit SQLite cursor values as BigInt or decimal strings rather than assuming every value fits a JavaScript `number`. HTTPS request/response is sufficient for correctness; WebSockets can reduce latency. Authentication is required, but there is no per-batch permission filtering in the initial implementation.

The current transport uses CBOR. Each change is a nine-position tuple in CR-SQLite's column order, with byte strings for `pk`, `site_id`, and BLOB values. A device uploads bounded groups of changes and receives a `(db_version, seq)` acknowledgement after the server commits them. Downloads use a CBOR Sequence: a header gives the change count and snapshot target version, followed by one tuple per change. The server reads from a separate SQLite snapshot and honors HTTP backpressure. The device applies groups transactionally and checkpoints `(db_version, seq)` after each group; it advances to the snapshot target only after the complete stream arrives. The UI reports counts of uploaded and applied changes. Existing version-only checkpoints are interpreted as complete through that version.

The shared catalog uses unprefixed `equipment_models`, capability child tables, and `inventory` CRR tables with the same change encoding. Devices request changes after their stored server cursor and apply them locally; they never upload catalog changes. The browser stores this checkpoint in `sync_state`, while SQLite `user_version` records the catalog schema version. Normal updates transfer changed rows only. A new device receives the full history once. Catalog and workspace schema upgrades migrate in place, preserving compatible rows and values and carrying forward data with a straightforward mapping. Workspace upgrades reconcile missing or changed tables in place and do not discard unrelated workspace rows.

Use SQLite `PRAGMA user_version` for numbered schema migrations in the auth, catalog, and workspace databases. Browser and server copies of a workspace use the same schema version. Sync checkpoints remain in the browser's `sync_state` table and are updated transactionally with received changes.

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
