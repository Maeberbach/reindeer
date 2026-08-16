# Reindeer: FairPlay — Rebuild Instructions

Full-stack estate property division app. Express + Vite + React + Tailwind + Drizzle ORM + SQLite (better-sqlite3).

## Requirements

- Node.js 20+
- npm

## Rebuild steps

```bash
unzip fair-choice-source.zip -d fair-choice
cd fair-choice
npm install
npm run dev
```

The dev server runs Express + Vite together on port 5000. Open http://localhost:5000.

SQLite database (`data.db`) is created automatically on first start. All runtime migrations, including the v8 high-value fiduciary workflow, run at startup from `server/storage.ts`.

## Build for production

```bash
npm run build
NODE_ENV=production node dist/index.cjs
```

## Key files

- `shared/schema.ts` — Drizzle schema, insert schemas, TS types, and v8 fiduciary constants + helpers (ITEM_STATES, EQUALIZATION_PATHS, VALUE_STATUSES, `finalizationBlockers`, `thresholdBreaches`, `recommendedFallbackPath`)
- `server/storage.ts` — DB bootstrap, migrations wiring, IStorage implementation
- `server/migrations/v8_high_value_fiduciary.ts` — Adds items/sessions columns and five fiduciary tables (item_valuations, equalization_decisions, consents, finalization_events, high_value_audit_log)
- `server/routes.ts` — Express API routes
- `client/src/` — React frontend (wouter hash router, shadcn/ui, TanStack Query)

## v8 status

Schema and migration are in and type-check clean. Storage CRUD, API routes, and UI for the fiduciary workflow (valuation ledger, equalization decisions, consent capture, finalization gate, PR override) are the next runtime tasks.
