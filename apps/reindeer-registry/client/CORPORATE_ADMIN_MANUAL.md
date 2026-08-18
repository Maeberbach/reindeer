# Reindeer Corporate Admin — Instruction Manual

## Overview

The Reindeer Corporate Admin is a single dashboard that controls feature toggles, estate management, and data access policies across all three Reindeer apps — Registry, FairPlay, and Discovery. Each app is sold independently, but all three share the same corporate admin architecture.

## Two-Tier Admin Access

### Tier 1: Corporate Admin (REINDEER_ADMIN_KEY)
This is the **business operations** key. It allows you to:
- View estate metadata (item counts, user counts — NO item content)
- Toggle feature flags on/off at runtime
- Reset an estate to fresh state (delete all data for a new client)
- View subscription status and license info

**What it does NOT do:** It cannot see item names, photos, participant names, audit logs, or any estate content. A client can be told truthfully: "Reindeer Corp cannot see your estate contents."

### Tier 2: Support Admin (REINDEER_SUPPORT_KEY)
This is the **data access** key. It allows:
- Full item list (titles, descriptions, categories, rooms)
- Delete individual items
- Full participant roster (names, emails, roles)
- Audit log access (Registry only)
- Database stats (Registry only)

**This key is NOT configured by default on sold installations.** Every call through it is audit-logged with a timestamp. If you need to support a client and they grant permission, you set `REINDEER_SUPPORT_KEY` on their Render instance at that time — and remove it when done.

## Accessing the Corporate Admin Dashboard

### URL
The corporate admin dashboard is served from each app. The primary access point:

```
https://reindeer-registry.onrender.com/corporate-admin.html
```

You can also access it from FairPlay or Discovery:
```
https://reindeer-fair-play.onrender.com/corporate-admin.html (if deployed there)
https://reindeer-discovery.onrender.com/corporate-admin.html (if deployed there)
```

### Quick-access with key in URL
```
https://reindeer-registry.onrender.com/corporate-admin.html?key=YOUR_ADMIN_KEY
```

### How to Use
1. Open the corporate admin URL in your browser
2. Enter the REINDEER_ADMIN_KEY in the key field
3. Click "Connect"
4. The dashboard will load all three apps in parallel, showing:
   - Connection status (green/red dot)
   - Item and user counts
   - Support key status (configured or not)
   - All feature toggles with on/off switches
   - Estate reset button (red, requires double confirmation)

## Feature Toggles

### Registry Feature Flags

| Flag | Default | What It Does |
|------|---------|--------------|
| `subscriptionGate` | OFF | When ON: blocks write operations (POST/PUT/PATCH/DELETE) for estates with expired subscriptions (HTTP 402). Read access is never blocked. |
| `passwordLogin` | OFF | When ON: enables username/password login as an alternative to magic links. |
| `licenseKeys` | OFF | When ON: validates JWT license keys. Lapsed keys get read-only access. |
| `multiEstate` | OFF | When ON: uses per-user scope_id (multi-estate per install). When OFF: single estate. |
| `encryption` | OFF | When ON: each estate DB encrypted with SQLCipher. Requires REINDEER_MASTER_KEY env var. |

### FairPlay Feature Flags

| Flag | Default | What It Does |
|------|---------|--------------|
| `passwordLogin` | OFF | Same as Registry. |
| `licenseKeys` | OFF | Same as Registry. |
| `multiEstate` | OFF | Same as Registry. |
| `encryption` | OFF | Same as Registry. |

### Discovery Feature Flags

| Flag | Default | What It Does |
|------|---------|--------------|
| `subscriptionGate` | OFF | Same as Registry. |
| `multiEstate` | OFF | Same as Registry. |
| `heirVisibility` | ON | When ON: strips private fields (pricing, recipient, ownership tags, AI confidence) from heir-facing endpoints. When OFF: heirs see everything. |

### How to Toggle
1. In the corporate admin dashboard, find the app card
2. Find the feature flag row
3. Click the toggle switch (green = ON, gray = OFF)
4. The change takes effect immediately at runtime — no restart or redeploy needed

### Important: Testing Mode
All feature flags are OFF (except heirVisibility in Discovery) for testing. This means:
- No subscription enforcement — unlimited read/write access
- No license key validation — all access is unlimited
- No encryption — databases are plain SQLite
- Heirs can see all item data in Discovery (heirVisibility OFF would show private data)

**Before selling to a client**, toggle ON: `subscriptionGate`, `licenseKeys`, `encryption`, `passwordLogin` (if you want password auth), and `heirVisibility` (Discovery).

## Estate Reset

The reset button wipes all estate data, returning the app to a fresh state. This is used when:
- Prepping a clean installation for a new client
- Clearing test data before going live
- Resetting after a client's estate process is complete and data has been exported

### What Gets Deleted

**Registry:** items, item_photos, item_closeups, item_tags, audit_log
**FairPlay:** session data, items, participants, rankings (via storage.resetSession)
**Discovery:** discovery_heirs, discovery_reactions, discovery_sessions, estate_settings

### What Does NOT Get Deleted
- The estate's scope_id / ULID
- User accounts (the bootstrap owner)
- License key / subscription records (Registry)
- App configuration / env vars on Render

### How to Reset
1. Open corporate admin dashboard
2. Find the app card you want to reset
3. Click the red "Reset Estate Data" button
4. Confirm TWICE (the dialog asks two times)
5. The dashboard will reload showing zero items and zero users

## Setting Environment Variables on Render

### REINDEER_ADMIN_KEY (required)
This must be set on every Render service for corporate admin to work.

```bash
# Via Render API:
curl -X PUT \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/{SERVICE_ID}/env-vars" \
  -d '[{"key":"REINDEER_ADMIN_KEY","value":"YOUR_SECURE_KEY_HERE"}]'
```

The key must be at least 16 characters. Use a random hex string:
```bash
openssl rand -hex 20
```

### REINDEER_SUPPORT_KEY (optional, NOT set by default)
Only set this when a client has granted data access permission for support.

```bash
curl -X PUT \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/{SERVICE_ID}/env-vars" \
  -d '[{"key":"REINDEER_SUPPORT_KEY","value":"YOUR_SUPPORT_KEY_HERE"}]'
```

To remove it (revoke data access):
```bash
curl -X DELETE \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/{SERVICE_ID}/env-vars/REINDEER_SUPPORT_KEY"
```

## API Reference (for automation/scripts)

All endpoints require the `x-admin-key` header (Tier 1) or `x-support-key` header (Tier 2).

### Corporate Admin Endpoints (Tier 1 — REINDEER_ADMIN_KEY)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/status` | Estate metadata: counts, feature flags, subscription status. No item content. |
| GET | `/api/admin/feature-flags` | Current feature flag values. |
| POST | `/api/admin/feature-flags` | Toggle flags. Body: `{"flagName": true/false}` (Registry/FairPlay) or `{"flag":"flagName","value":true/false}` (Discovery). |
| POST | `/api/admin/reset` | Wipe all estate data. Returns `{ok:true, message:"Estate reset to fresh state."}`. |
| POST | `/api/admin/max-frames` | (Registry only) Set max room photos (1-8). |
| POST | `/api/admin/generate-license` | (Registry only) Generate a license key. |

### Support Admin Endpoints (Tier 2 — REINDEER_SUPPORT_KEY)

Returns 403 if REINDEER_SUPPORT_KEY is not configured.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/admin/items` | Full item list with titles, descriptions, categories. |
| DELETE | `/api/admin/items/:id` | Delete a single item. |
| GET | `/api/admin/participants` | Full participant roster (names, emails, roles). |
| GET | `/api/admin/audit` | (Registry only) Full audit log. |
| GET | `/api/admin/db-stats` | (Registry only) Raw database table stats. |
| GET | `/api/admin/heirs` | (Discovery only) Heir list with names, emails, relationships. |

### Example API Calls

```bash
# Check estate status
curl -H "x-admin-key: YOUR_KEY" https://reindeer-registry.onrender.com/api/admin/status

# Toggle subscription gate ON
curl -X POST -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_KEY" \
  -d '{"subscriptionGate": true}' \
  https://reindeer-registry.onrender.com/api/admin/feature-flags

# Reset estate
curl -X POST -H "x-admin-key: YOUR_KEY" \
  https://reindeer-registry.onrender.com/api/admin/reset
```

## Selling Apps Independently

Each app is sold as a standalone product. When a client purchases an app:

1. **Deploy** a new Render service instance for that app (or use the existing multi-tenant instance)
2. **Set** `REINDEER_ADMIN_KEY` on the new instance
3. **Do NOT set** `REINDEER_SUPPORT_KEY` (data stays private)
4. **Toggle ON** the feature flags appropriate for the sale:
   - `subscriptionGate` → ON (enforce payment)
   - `licenseKeys` → ON (validate their license)
   - `encryption` → ON (protect data at rest)
   - `passwordLogin` → ON if they want password auth
   - `heirVisibility` → ON (Discovery only)
5. **Generate** a license key via `POST /api/admin/generate-license` (Registry)
6. **Reset** the estate data to give the client a clean slate
7. **Share** the license key and app URL with the client

## Fiduciary Distribution Model

When a fiduciary (bank trust dept, lawyer, investment firm) distributes Reindeer to their clients:

1. The fiduciary purchases an annual license pool (N estate slots)
2. Each client gets their own license key from the pool
3. The fiduciary refers the client to Reindeer for activation
4. Reindeer activates the estate under the fiduciary's pool
5. Each estate's data is encrypted and private — the fiduciary accesses client data through normal app auth (as trustee), NOT through the corporate admin
6. The corporate admin panel shows the fiduciary: slots used / remaining / expiry dates (metadata only)
7. The fiduciary does NOT see client estate contents via the admin layer

## Security Model Summary

```
┌─────────────────────────────────────────────┐
│           Corporate Admin (Tier 1)           │
│         REINDEER_ADMIN_KEY (always on)        │
│                                              │
│  ✅ Feature flag toggles                     │
│  ✅ Estate metadata (counts only)            │
│  ✅ License management                       │
│  ✅ Estate reset (deletes data, never reads) │
│  ✅ Subscription status                      │
│                                              │
│  ❌ Item content (titles, photos, etc.)      │
│  ❌ Participant names/emails                 │
│  ❌ Audit log entries                        │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│           Support Admin (Tier 2)             │
│        REINDEER_SUPPORT_KEY (default OFF)     │
│                                              │
│  ✅ Full item list (titles, descriptions)    │
│  ✅ Delete individual items                   │
│  ✅ Participant roster (names, emails)       │
│  ✅ Audit log (Registry)                     │
│  ✅ Database stats (Registry)                │
│                                              │
│  Every call is audit-logged with timestamp   │
│  Returns 403 when key not configured         │
└─────────────────────────────────────────────┘
```

## Troubleshooting

### "Backdoor admin only" error
The admin key is incorrect or not set. Verify `REINDEER_ADMIN_KEY` is set on Render and you're sending the correct value in the `x-admin-key` header.

### "Support key required for data access" error
`REINDEER_SUPPORT_KEY` is not configured on this installation. This is the expected behavior for sold installs — data access is intentionally disabled.

### Connection failed in dashboard
Check that the Render service is running:
```bash
curl https://reindeer-registry.onrender.com/api/health
```
If it returns a health response, the app is up but may not have `REINDEER_ADMIN_KEY` set.

### Feature flag not taking effect
Feature flags are updated in-memory at runtime. If the app restarts (Render redeploys), flags revert to their code defaults. For permanent changes, update the code in `featureFlags.js` (or `.ts`) and redeploy.

### Discovery feature flags not persisting
Discovery stores feature flag overrides in a `estate_settings` SQLite table. These survive restarts. Registry and FairPlay use in-memory flags that reset on restart — for permanent changes, edit the source code.
