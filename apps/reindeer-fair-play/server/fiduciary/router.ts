/**
 * v8 — High-value fiduciary workflow REST routes.
 *
 * `createFiduciaryRouter()` returns a plain express.Router the caller mounts
 * at whatever base path it chooses (e.g. `app.use("/api/fiduciary",
 * createFiduciaryRouter())`). Nothing here assumes its own mount point.
 *
 * Auth: identity comes from `req.actor`, set by the shared `attachActor`
 * middleware (server/auth/middleware.ts) before this router's requests ever
 * arrive — server/routes.ts mounts `attachActor` and a deny-by-default gate
 * over all of `/api`, including `/api/fiduciary`, ahead of this router. This
 * file used to resolve the acting participant from the request body/header
 * itself (the same vulnerability as the old routes.ts `actorOf`) and has
 * been switched to the shared guard so there is exactly one place identity
 * is ever resolved from client input — nowhere.
 *
 * `participantId`/`actorId` fields still accepted in several request bodies
 * below are now unused leftovers of that old model; the zod schemas keep
 * accepting them (for backward-compatible request shapes) but nothing reads
 * them for identity anymore.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { wrapRouterAsync } from "../asyncHandler";
import {
  fiduciary,
  FiduciaryError,
  type RecordOfDecisions,
  type SessionSnapshot,
} from "./fiduciaryStorage";
import { denyIfNotCaptain, actorIdOf } from "../auth/sharedGuards";

function fail(res: Response, e: unknown) {
  if (e instanceof FiduciaryError) {
    res.status(e.status).json({ message: e.message });
    return;
  }
  if (e instanceof z.ZodError) {
    const first = e.issues[0];
    res.status(400).json({
      message: first ? `${first.path.join(".") || "request"}: ${first.message}` : "Invalid request.",
    });
    return;
  }
  // Never leak raw driver/SQL errors to the client.
  const message =
    e && typeof e === "object" && "message" in e && typeof (e as any).message === "string"
      ? (e as any).message
      : "Request failed.";
  const looksLikeDbError = /SQLITE_|sqlite3|drizzle/i.test(message);
  res.status(400).json({ message: looksLikeDbError ? "Request failed." : message });
}

/* ------------------------------------------------------------------ */
/* Validation schemas                                                  */
/* ------------------------------------------------------------------ */

const addValuationSchema = z.object({
  value: z.number(),
  valueLow: z.number().nullable().optional(),
  valueHigh: z.number().nullable().optional(),
  source: z.enum(["ai", "manual", "appraisal", "comparable_sale", "auction", "other"]),
  status: z.enum(["estimated", "pending_review", "approved", "disputed", "stale"]).optional(),
  notes: z.string().optional(),
  attachmentUrl: z.string().nullable().optional(),
  participantId: z.union([z.number(), z.string()]).optional(),
  actorId: z.union([z.number(), z.string()]).optional(),
});

const disputeValuationSchema = z.object({
  reason: z.string().min(1, "A reason is required to dispute a valuation."),
  participantId: z.union([z.number(), z.string()]).optional(),
  actorId: z.union([z.number(), z.string()]).optional(),
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function parseItemId(req: Request): number {
  const id = Number(req.params.itemId);
  if (Number.isNaN(id)) throw new FiduciaryError("Invalid item id.", 400);
  return id;
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */

export function createFiduciaryRouter(): Router {
  const router = Router();
  wrapRouterAsync(router);

  /* ---------- valuations ---------- */
  router.get("/items/:itemId/valuations", async (req: Request, res: Response) => {
    try {
      const itemId = parseItemId(req);
      res.json(await fiduciary.listValuations(itemId));
    } catch (e) {
      fail(res, e);
    }
  });

  router.post("/items/:itemId/valuations", async (req: Request, res: Response) => {
    try {
      const itemId = parseItemId(req);
      const body = addValuationSchema.parse(req.body ?? {});
      const actorId = actorIdOf(req);
      const row = await fiduciary.addValuation(
        itemId,
        {
          value: body.value,
          valueLow: body.valueLow ?? null,
          valueHigh: body.valueHigh ?? null,
          source: body.source,
          status: body.status,
          notes: body.notes,
          attachmentUrl: body.attachmentUrl ?? null,
        },
        actorId,
      );
      res.json(row);
    } catch (e) {
      fail(res, e);
    }
  });

  router.post("/items/:itemId/valuations/:id/approve", async (req: Request, res: Response) => {
    if (await denyIfNotCaptain(req, res)) return;
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) throw new FiduciaryError("Invalid valuation id.", 400);
      const actorId = actorIdOf(req);
      res.json(await fiduciary.approveValuation(id, actorId));
    } catch (e) {
      fail(res, e);
    }
  });

  router.post("/items/:itemId/valuations/:id/dispute", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (Number.isNaN(id)) throw new FiduciaryError("Invalid valuation id.", 400);
      const body = disputeValuationSchema.parse(req.body ?? {});
      const actorId = actorIdOf(req);
      res.json(await fiduciary.disputeValuation(id, body.reason, actorId));
    } catch (e) {
      fail(res, e);
    }
  });

  /* ================================================================ */
  /* v14 Trustee Handoff endpoints                                     */
  /* ================================================================ */

  /* ---------- flag-for-appraisal (any authenticated participant) ---------- */
  router.post("/items/:itemId/flag-high-value", async (req: Request, res: Response) => {
    try {
      const itemId = parseItemId(req);
      const actor = req.actor;
      if (!actor) {
        res.status(401).json({ message: "Please sign in to flag an item for appraisal." });
        return;
      }
      const body = z.object({ reason: z.string().optional() }).parse(req.body ?? {});
      const item = await fiduciary.flagForAppraisal(itemId, actor.id, body.reason ?? "");
      res.json(item);
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- method agreements (up-front buy-in) ---------- */
  router.get("/method-agreements", async (_req: Request, res: Response) => {
    try {
      const session = await storage.getSession();
      res.json(await fiduciary.listMethodAgreements(session.id));
    } catch (e) {
      fail(res, e);
    }
  });

  router.post("/method-agreements", async (req: Request, res: Response) => {
    try {
      const actor = req.actor;
      if (!actor) {
        res.status(401).json({ message: "Please sign in to record your agreement." });
        return;
      }
      const session = await storage.getSession();
      const agreement = await fiduciary.recordMethodAgreement({
        sessionId: session.id,
        participantId: actor.id,
        clientIp: req.ip ?? null,
        clientUserAgent: req.header("user-agent") ?? null,
      });
      res.json(agreement);
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- record of decisions (trustee handoff document) ---------- */
  router.get("/record-of-decisions", async (_req: Request, res: Response) => {
    try {
      const session = await storage.getSession();
      res.json(await fiduciary.generateRecordOfDecisions(session.id));
    } catch (e) {
      fail(res, e);
    }
  });

  router.get("/record-of-decisions/print", async (_req: Request, res: Response) => {
    try {
      const session = await storage.getSession();
      const record = await fiduciary.generateRecordOfDecisions(session.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderRecordOfDecisionsHtml(record));
    } catch (e) {
      fail(res, e);
    }
  });

  /* ---------- snapshot export (available in every phase) ---------- */

  /**
   * Read-only "state as of now" for any signed-in participant. Available in
   * every phase, including the phases where the Record of Decisions would
   * refuse to run (roster/intake, mid-ranking, paused, etc). This is the
   * graceful-exit path when cooperation collapses: the heirs stop using the
   * app and hand the snapshot to the trustee, who then distributes property
   * by whatever means they would have used without the app.
   *
   * Deliberately not gated by captain: any heir can save the state. No
   * side effects, no audit rows written.
   */
  router.get("/snapshot", async (_req: Request, res: Response) => {
    try {
      const session = await storage.getSession();
      res.json(await fiduciary.getSnapshot(session.id));
    } catch (e) {
      fail(res, e);
    }
  });

  /**
   * Printable HTML view of the same snapshot. Titled "Snapshot as of
   * [timestamp]." Print-to-PDF from the browser produces the PDF the spec
   * asks for without hauling in a PDF renderer on the server.
   */
  router.get("/snapshot/print", async (_req: Request, res: Response) => {
    try {
      const session = await storage.getSession();
      const snapshot = await fiduciary.getSnapshot(session.id);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(renderSnapshotHtml(snapshot));
    } catch (e) {
      fail(res, e);
    }
  });

  return router;
}

/* ================================================================ */
/* v14 Trustee Handoff — printable Record of Decisions               */
/* ================================================================ */

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function fmtMoney(v: number | null): string {
  if (v == null) return "—";
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

/**
 * Renders the trustee-facing Record of Decisions as printable HTML. Large,
 * plain, forgiving typography per project standing rules (elderly-friendly).
 * Server-rendered so the trustee can print from any browser without JS.
 */
export function renderRecordOfDecisionsHtml(r: RecordOfDecisions): string {
  const money = (n: number | null): string =>
    n == null ? `<span class="muted">n/a</span>` : esc(fmtMoney(n));
  const room = (s: string | null): string => (s ? esc(s) : `<span class="muted">—</span>`);

  const heirRows = r.heirs
    .map(
      (h) =>
        `<li><strong>${esc(h.name)}</strong> — Method Agreement signed ${esc(fmtDate(h.methodAgreedAt))}</li>`,
    )
    .join("\n");

  // Per-stage sections. Each stage lists heirs; each heir's items appear as
  // a small table with room / category / estimate columns. Missing estimates
  // print "n/a" — never blocks the print.
  const stageSections = r.stages
    .map((stage) => {
      const heirBlocks = stage.byHeir
        .map((entry) => {
          const rows = entry.items
            .map(
              (it) => `<tr>
              <td>${esc(it.itemName)}</td>
              <td>${room(it.room)}</td>
              <td>${room(it.category)}</td>
              <td class="num">${money(it.estimate)}</td>
            </tr>`,
            )
            .join("\n");
          return `<div class="heir-block">
            <h4>${esc(entry.heirName)} <span class="count">(${entry.items.length} item${entry.items.length === 1 ? "" : "s"})</span></h4>
            <table class="items">
              <thead><tr>
                <th>Item</th><th>Room</th><th>Category</th><th class="num">Estimate</th>
              </tr></thead>
              <tbody>
${rows}
              </tbody>
              <tfoot><tr>
                <td colspan="3" class="num muted">Subtotal (estimate)</td>
                <td class="num">${esc(fmtMoney(entry.subtotalEstimate))}</td>
              </tr></tfoot>
            </table>
          </div>`;
        })
        .join("\n");
      const kindTag =
        stage.groupingType && stage.groupingType !== "general"
          ? `<span class="tag">${esc(stage.groupingType)}</span>`
          : "";
      return `<section class="stage">
        <h3>${esc(stage.groupingName)} ${kindTag}</h3>
        ${heirBlocks || `<p class="muted">No items assigned in this stage.</p>`}
        <p class="stage-total"><strong>Stage total (estimate):</strong> ${esc(fmtMoney(stage.stageTotalEstimate))}</p>
      </section>`;
    })
    .join("\n");

  const escalationRows = r.escalatedToTrustee.items
    .map(
      (e) => `<tr>
        <td>${esc(e.itemName)}</td>
        <td>${room(e.room)}</td>
        <td>${room(e.category)}</td>
        <td>${esc(e.escalationSourceLabel)}</td>
        <td>${e.recipientHint ? esc(e.recipientHint) : `<span class="muted">—</span>`}</td>
        <td class="num">${money(e.estimate)}</td>
      </tr>`,
    )
    .join("\n");

  const unassignedRows = r.unassigned
    .map(
      (it) => `<tr>
        <td>${esc(it.itemName)}</td>
        <td>${room(it.room)}</td>
        <td>${room(it.category)}</td>
        <td class="num">${money(it.estimate)}</td>
      </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Record of Decisions — ${esc(r.session.estateName ?? r.session.name)}</title>
<style>
  :root { --ink: #1a1a1a; --muted: #6b6b6b; --line: #d0d0d0; --accent: #4a5d3f; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: var(--ink); font: 16pt/1.5 Georgia, "Times New Roman", serif; background: #fff; }
  main { max-width: 8.5in; margin: 0 auto; padding: 0.75in 0.75in 1in; }
  h1 { font-size: 28pt; margin: 0 0 4pt; }
  h2 { font-size: 18pt; margin: 24pt 0 8pt; border-bottom: 1px solid var(--line); padding-bottom: 4pt; }
  .subtitle { color: var(--muted); font-size: 14pt; margin-bottom: 24pt; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 4pt 16pt; margin: 12pt 0 24pt; font-size: 13pt; }
  .meta dt { color: var(--muted); }
  ul.heirs { padding-left: 20pt; }
  ul.heirs li { margin: 4pt 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 12pt; font-size: 13pt; }
  th, td { text-align: left; padding: 8pt 10pt; vertical-align: top; border-bottom: 1px solid var(--line); }
  th { background: #f4f4ee; font-weight: 600; }
  td.num, th.num { text-align: right; }
  .muted { color: var(--muted); }
  .pending { color: #8a5a00; font-style: italic; }
  .tag { display: inline-block; font-size: 10pt; padding: 1pt 6pt; margin-left: 6pt; border: 1px solid var(--accent); color: var(--accent); border-radius: 3pt; vertical-align: 1pt; }
  .totals { margin-top: 16pt; font-size: 13pt; color: var(--muted); }
  .note { background: #fbf7ea; border-left: 4pt solid #d4b96b; padding: 12pt 16pt; margin: 24pt 0; font-size: 12pt; line-height: 1.55; }
  .note.closing { background: #eef4ec; border-left-color: var(--accent); }
  section.stage { margin: 20pt 0; break-inside: avoid; }
  section.stage h3 { font-size: 16pt; margin: 12pt 0 4pt; }
  .heir-block { margin: 10pt 0 14pt; }
  .heir-block h4 { font-size: 14pt; margin: 8pt 0 4pt; }
  .heir-block .count { color: var(--muted); font-weight: normal; font-size: 12pt; }
  table.items { font-size: 12pt; }
  .stage-total { margin-top: 6pt; font-size: 12pt; color: var(--ink); }
  footer { margin-top: 36pt; padding-top: 12pt; border-top: 1px solid var(--line); font-size: 11pt; color: var(--muted); }
  @media print {
    main { padding: 0.5in; }
    .note { break-inside: avoid; }
    table { break-inside: auto; }
    tr { break-inside: avoid; break-after: auto; }
  }
</style>
</head>
<body>
<main>
  <h1>Record of Decisions</h1>
  <div class="subtitle">${esc(r.session.estateName ?? r.session.name)}</div>

  <dl class="meta">
    <dt>Captain</dt><dd>${esc(r.captain.name ?? "—")}</dd>
    <dt>Generated</dt><dd>${esc(fmtDate(r.generatedAt))}</dd>
    <dt>Total items</dt><dd>${r.totals.itemCount}</dd>
    <dt>Appraised</dt><dd>${r.totals.appraisedCount} (${esc(fmtMoney(r.totals.totalAppraisedValue))})</dd>
    <dt>Pending appraisal</dt><dd>${r.totals.pendingAppraisalCount}</dd>
  </dl>

  <div class="note">
    <strong>How to read this document.</strong> FairPlay ran the family's
    distribution game and produced this record. Each heir listed below signed a
    Method Agreement accepting the process. Ordinary items and their estimated
    values are grouped by stage and by heir. Items the family or the owner
    flagged as <em>high value</em> appear separately below; the trustee
    commissions appraisals for those and applies the trust's fairness rules
    externally. Estimates shown here are family-supplied guesses and are
    intended as a starting point for the trustee, not a final valuation.
  </div>

  <h2>Heirs</h2>
  <ul class="heirs">
${heirRows || `    <li class="muted">No heirs recorded.</li>`}
  </ul>

  <h2>Ordinary items — assigned by stage</h2>
  ${stageSections || `<p class="muted">No stage assignments recorded.</p>`}

  ${
    r.unassigned.length > 0
      ? `<h2>Ordinary items — unassigned</h2>
  <p class="muted">These items had no provisional recipient when the record was generated.</p>
  <table>
    <thead><tr><th>Item</th><th>Room</th><th>Category</th><th class="num">Estimate</th></tr></thead>
    <tbody>
${unassignedRows}
    </tbody>
  </table>`
      : ""
  }

  <h2>Flagged for appraisal — items the trustee will value</h2>
  ${
    r.escalatedToTrustee.items.length > 0
      ? `<p class="muted">These items were flagged for appraisal during the process. The
    trustee commissions professional appraisals and applies the trust's
    fairness rules; the app does not attempt to equalize them. Missing
    estimates below are shown as <em>n/a</em> and do not block the print.</p>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th>Room</th>
        <th>Category</th>
        <th>Flagged by</th>
        <th>Owner's hint</th>
        <th class="num">Estimate</th>
      </tr>
    </thead>
    <tbody>
${escalationRows}
    </tbody>
    <tfoot><tr>
      <td colspan="5" class="num muted">Estimated total (excludes ${r.escalatedToTrustee.itemsWithoutEstimate} without an estimate)</td>
      <td class="num">${esc(fmtMoney(r.escalatedToTrustee.totalEstimate))}</td>
    </tr></tfoot>
  </table>`
      : `<p class="muted">No items were flagged for the trustee's appraisal.</p>`
  }

  <div class="note closing">
    <strong>Closing note for the trustee.</strong> The ordinary-item stages
    above reflect the heirs' choices under a signed Method Agreement. The
    high-value section is the trustee's to resolve: obtain appraisals, apply
    the equalization or offset rules the trust specifies, and settle the
    financial side of the estate. Estimates in this document are
    family-supplied and non-binding.
  </div>

  <footer>
    Prepared by Reindeer: FairPlay. This record is the family's agreed
    distribution of personal property; the trustee balances the financial
    side using other estate assets under the applicable fiduciary standards.
  </footer>
</main>
</body>
</html>`;
}

/* ================================================================ */
/* Snapshot export — printable state-of-now                          */
/* ================================================================ */

function fmtTimestamp(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Renders the read-only "state as of now" snapshot as printable HTML.
 * Explicitly not a Record of Decisions — the top of the page states so.
 * This is what the heirs hand to the trustee when they stop using the app.
 */
export function renderSnapshotHtml(s: SessionSnapshot): string {
  const rosterRows = s.roster
    .map(
      (p) =>
        `      <li><strong>${esc(p.name)}</strong> — ${esc(p.role ?? "heir")}${
          p.isAdmin ? " (heir admin)" : ""
        }${p.administersOnly ? " · administers only" : ""}${
          s.session.captainParticipantId === p.id ? " · <em>current captain</em>" : ""
        }</li>`,
    )
    .join("\n");

  const itemRows = s.items
    .map((it) => {
      const recipient = it.provisionalRecipientId
        ? s.roster.find((r) => r.id === it.provisionalRecipientId)?.name ?? "—"
        : "—";
      return `      <tr>
        <td>${esc(it.name)}</td>
        <td>${esc(it.room ?? "")}</td>
        <td>${it.needsAppraisal ? "Yes" : "No"}</td>
        <td>${esc(recipient)}</td>
        <td class="num">${it.approvedValue != null ? esc(fmtMoney(it.approvedValue)) : "—"}</td>
      </tr>`;
    })
    .join("\n");

  const rankingRows = s.rankings
    .map((r) => {
      const heir = s.roster.find((p) => p.id === r.participantId)?.name ?? `#${r.participantId}`;
      const item = s.items.find((i) => i.id === r.itemId)?.name ?? `#${r.itemId}`;
      return `      <tr><td>${esc(heir)}</td><td>${esc(item)}</td><td class="num">${r.rank}</td></tr>`;
    })
    .join("\n");

  const agreementRows = s.methodAgreements
    .map((a) => {
      const heir = s.roster.find((p) => p.id === a.participantId)?.name ?? `#${a.participantId}`;
      const captain =
        s.roster.find((p) => p.id === a.captainParticipantId)?.name ?? `#${a.captainParticipantId}`;
      const active = a.captainParticipantId === s.session.captainParticipantId;
      return `      <tr>
        <td>${esc(heir)}</td>
        <td>${esc(captain)}${active ? ` <em>(current captain)</em>` : " <span class=\"muted\">(superseded)</span>"}</td>
        <td>${esc(fmtTimestamp(a.agreedAt))}</td>
        <td>v${esc(a.agreementVersion)}</td>
      </tr>`;
    })
    .join("\n");

  const auditRows = s.auditLog
    .map(
      (a) =>
        `      <tr><td>${esc(fmtTimestamp(a.createdAt))}</td><td>${esc(a.eventType)}</td><td>${
          a.itemId ? `Item #${a.itemId}` : "session"
        }</td><td>${
          a.actorParticipantId
            ? esc(s.roster.find((p) => p.id === a.actorParticipantId)?.name ?? `#${a.actorParticipantId}`)
            : "—"
        }</td></tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Snapshot as of ${esc(fmtTimestamp(s.generatedAt))}</title>
<style>
  body { font-family: Georgia, "Iowan Old Style", serif; color: #1a1a1a; margin: 2rem auto; max-width: 900px; padding: 0 1.5rem; line-height: 1.5; font-size: 16pt; }
  h1 { font-size: 26pt; margin-top: 0; }
  h2 { font-size: 18pt; border-bottom: 1px solid #ccc; padding-bottom: 4pt; margin-top: 2rem; }
  dl { display: grid; grid-template-columns: 12rem 1fr; gap: 4pt 12pt; }
  dt { color: #555; }
  table { width: 100%; border-collapse: collapse; font-size: 12pt; }
  th, td { text-align: left; padding: 6pt 8pt; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { background: #f2f2ee; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #888; }
  .note { background: #faf5e6; border-left: 4pt solid #c9a44a; padding: 12pt 16pt; margin: 1rem 0; }
  footer { margin-top: 2rem; padding-top: 12pt; border-top: 1px solid #ccc; color: #555; font-size: 12pt; }
  ul.roster { list-style: none; padding-left: 0; }
  ul.roster li { padding: 4pt 0; }
  pre { background: #f6f5f0; padding: 12pt; border-radius: 4pt; white-space: pre-wrap; font-family: Georgia, serif; font-size: 13pt; }
</style>
</head>
<body>
<main>
  <h1>Snapshot as of ${esc(fmtTimestamp(s.generatedAt))}</h1>

  <div class="note">
    <strong>This is not a decision.</strong> It is a plain record of what the app
    knows right now. Use it when the heirs decide to stop using the app: hand it
    to the trustee, who will handle the distribution outside the app under the
    will and trust.
  </div>

  <h2>Session</h2>
  <dl>
    <dt>Name</dt><dd>${esc(s.session.name)}</dd>
    <dt>Phase</dt><dd>${esc(s.session.phase)}</dd>
    <dt>Lifecycle</dt><dd>${esc(s.session.lifecycleState)}</dd>
    <dt>Captain</dt><dd>${esc(s.session.captainName ?? "—")}</dd>
    <dt>Inventory completed</dt><dd>${esc(fmtTimestamp(s.session.inventoryCompletedAt))}</dd>
    <dt>Ranking opened</dt><dd>${esc(fmtTimestamp(s.session.rankingOpenedAt))}</dd>
  </dl>

  <h2>Roster</h2>
  <ul class="roster">
${rosterRows || `    <li class="muted">Nobody on the roster yet.</li>`}
  </ul>

  <h2>Method Agreement (current text, version ${esc(s.currentMethodAgreementVersion)})</h2>
  <pre>${esc(s.currentMethodAgreementText)}</pre>

  <h2>Method Agreement signatures</h2>
  <table>
    <thead><tr><th>Heir</th><th>Captain named</th><th>Signed at</th><th>Version</th></tr></thead>
    <tbody>
${agreementRows || `      <tr><td colspan="4" class="muted">No signatures yet.</td></tr>`}
    </tbody>
  </table>

  <h2>Items (${s.items.length})</h2>
  <table>
    <thead><tr><th>Item</th><th>Room</th><th>High-value</th><th>Provisional recipient</th><th class="num">Approved value</th></tr></thead>
    <tbody>
${itemRows || `      <tr><td colspan="5" class="muted">No items yet.</td></tr>`}
    </tbody>
  </table>

  <h2>Rankings (${s.rankings.length})</h2>
  <table>
    <thead><tr><th>Heir</th><th>Item</th><th class="num">Rank</th></tr></thead>
    <tbody>
${rankingRows || `      <tr><td colspan="3" class="muted">No rankings recorded yet.</td></tr>`}
    </tbody>
  </table>

  <h2>Audit log (${s.auditLog.length})</h2>
  <table>
    <thead><tr><th>When</th><th>Event</th><th>Scope</th><th>Actor</th></tr></thead>
    <tbody>
${auditRows || `      <tr><td colspan="4" class="muted">No audit rows yet.</td></tr>`}
    </tbody>
  </table>

  <footer>
    Prepared by Reindeer: FairPlay. This snapshot is not a finalization and is
    not the Record of Decisions. It is a graceful-exit record for the trustee.
  </footer>
</main>
</body>
</html>`;
}
