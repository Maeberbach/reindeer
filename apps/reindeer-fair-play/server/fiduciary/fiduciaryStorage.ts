/**
 * v8 — High-value fiduciary workflow runtime.
 *
 * Drizzle CRUD + fiduciary gating logic over the surviving v8 tables
 * (itemValuations, highValueAuditLog) plus the v8 columns on `items`.
 *
 * Every mutating method here writes exactly one row to highValueAuditLog via
 * the private `audit()` helper, mirroring how the rest of the app treats
 * audit trails as a first-class side effect of every write (see
 * categoryChanges / classificationChanges / sessionStateChanges in
 * server/storage.ts).
 *
 * Money columns throughout this app are real dollars (not cents) — see
 * `items.approvedValue`, `itemValuations.value`, etc. Nothing in this file
 * converts units; it passes dollar amounts straight through.
 */
import { eq, and, desc, isNull } from "drizzle-orm";
import { db, storage } from "../storage";
import {
  items,
  itemValuations,
  highValueAuditLog,
  appraisalFlags,
  groupings,
  methodAgreements,
  CURRENT_METHOD_AGREEMENT_VERSION,
  renderMethodAgreementText,
  type Item,
  type ItemValuation,
  type HighValueAuditLogEntry,
  type HighValueAuditEvent,
  type MethodAgreement,
  type Participant,
  type Ranking,
  type Session,
} from "@shared/schema";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */
/**
 * Thrown for every refusal in this module (not-found, blocked finalization,
 * bad state transitions, etc). Routes catch this and translate `status` +
 * `message` into a plain-language JSON error — never a raw SQL/driver error.
 */
export class FiduciaryError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "FiduciaryError";
  }
}

function notFound(what: string): never {
  throw new FiduciaryError(`${what} not found.`, 404);
}

/* ------------------------------------------------------------------ */
/* Shapes returned to callers (routes / UI)                            */
/* ------------------------------------------------------------------ */
/**
 * The shape returned by getSnapshot(). Available in every session phase.
 * Everything is a plain JSON value so the client can save or print it
 * verbatim. Includes rankings-in-progress and every method-agreement row,
 * including superseded ones from earlier captain eras.
 */
export type SessionSnapshot = {
  generatedAt: number;
  session: {
    id: number;
    name: string;
    phase: Session["phase"];
    lifecycleState: Session["state"];
    captainParticipantId: number | null;
    captainName: string | null;
    inventoryCompletedAt: number | null;
    rankingOpenedAt: number | null;
  };
  roster: Participant[];
  items: Item[];
  rankings: Ranking[];
  methodAgreements: MethodAgreement[];
  currentMethodAgreementText: string;
  currentMethodAgreementVersion: string;
  auditLog: HighValueAuditLogEntry[];
};

/**
 * Structured shape returned by generateRecordOfDecisions. Consumed by both the
 * JSON endpoint and the server-rendered printable HTML.
 */
export type RecordOfDecisionsItem = {
  id: number;
  name: string;
  room: string | null;
  category: string | null;
  awardedToParticipantId: number | null;
  awardedToName: string | null;
  needsAppraisal: boolean;
  appraisedValue: number | null;
  valueSource: string | null;
  valuationDate: number | null;
  /** True when needsAppraisal but no approved value — goes to trustee marked pending. */
  pendingAppraisal: boolean;
  escalatingParticipantId: number | null;
  escalatingParticipantName: string | null;
};

/**
 * A per-heir line inside a stage section. Estimate is the latest attached
 * estimate (there is no "approval" concept in the reshaped app; every value
 * in the RoD is pre-appraisal). Missing estimate renders as "n/a" in the
 * print view.
 */
export type RoDStageLine = {
  itemId: number;
  itemName: string;
  room: string | null;
  category: string | null;
  estimate: number | null;
};

/**
 * One stage section (heirloom, jewelry, custom category, or the general
 * round). Groups items assigned to each heir inside that stage. Escalated
 * items do not appear here; they are collected in `escalatedToTrustee`.
 */
export type RoDStageSection = {
  groupingId: number | null;
  groupingName: string;
  groupingType: string;
  byHeir: Array<{
    heirId: number;
    heirName: string;
    items: RoDStageLine[];
    subtotalEstimate: number;
  }>;
  stageTotalEstimate: number;
};

/**
 * One row in the "Escalated to the trustee" section. Every currently
 * in_high_value item lands here regardless of who flagged it or whether an
 * estimate exists.
 */
export type RoDEscalatedItem = {
  itemId: number;
  itemName: string;
  room: string | null;
  category: string | null;
  estimate: number | null;
  escalationSource: "heir" | "owner" | "ai" | "unknown";
  escalationSourceLabel: string;
  recipientHint: string | null;
};

export type RecordOfDecisions = {
  session: { id: number; name: string; estateName: string | null };
  captain: { id: number | null; name: string | null };
  heirs: Array<{ id: number; name: string; methodAgreedAt: number | null }>;
  items: RecordOfDecisionsItem[];
  /**
   * Additive per-stage breakdown (added in commit-1 of the fiduciary scope
   * collapse). Each entry corresponds to a `groupings` row that had items
   * assigned inside it, plus a synthetic entry for items with no grouping
   * (the general round). Read-only, derived from `items` + storage lookups.
   */
  stages: RoDStageSection[];
  /**
   * Items currently in `in_high_value` status. Separate section on the
   * printed report; the trustee commissions appraisals for these before
   * applying the trust's equalization rules.
   */
  escalatedToTrustee: {
    items: RoDEscalatedItem[];
    totalEstimate: number;
    itemsWithoutEstimate: number;
  };
  /** Session-level unassigned bucket: items with no provisional recipient. */
  unassigned: RoDStageLine[];
  totals: {
    itemCount: number;
    appraisedCount: number;
    pendingAppraisalCount: number;
    totalAppraisedValue: number;
  };
  generatedAt: number;
};

/* ------------------------------------------------------------------ */
/* FiduciaryStorage                                                    */
/* ------------------------------------------------------------------ */
export class FiduciaryStorage {
  /* ================================================================ */
  /* Audit                                                             */
  /* ================================================================ */
  /**
   * Writes one highValueAuditLog row. Every mutating method in this class
   * calls this exactly once. `actorId` of null is recorded as the captain acting
   * without signing in (matches the rest of the app's null-actor convention).
   */
  private async audit(args: {
    sessionId: number;
    itemId: number;
    eventType: HighValueAuditEvent;
    payload: Record<string, unknown>;
    stateBefore: string;
    stateAfter: string;
    valueAtEvent?: number | null;
    valueStatusAtEvent?: string | null;
    actorParticipantId: number | null;
    actorRole: "captain" | "heir" | "trustee" | "system" | "appraiser";
    reason?: string;
  }): Promise<HighValueAuditLogEntry> {
    return db
      .insert(highValueAuditLog)
      .values({
        sessionId: args.sessionId,
        itemId: args.itemId,
        eventType: args.eventType,
        payload: JSON.stringify(args.payload ?? {}),
        stateBefore: args.stateBefore,
        stateAfter: args.stateAfter,
        valueAtEvent: args.valueAtEvent ?? null,
        valueStatusAtEvent: args.valueStatusAtEvent ?? null,
        actorParticipantId: args.actorParticipantId,
        actorRole: args.actorRole,
        reason: args.reason ?? "",
        createdAt: Date.now(),
      })
      .returning()
      .get();
  }

  /**
   * Resolve a participant's role label for the audit log.
   *
   * Null actorId (no logged-in participant) = 'captain' — an unattributed
   * server-side action attributed to the session's captain seat. Previously
   * spelled 'pr' on the wire; renamed to 'captain' when the captain model
   * landed. There is no more Captain concept in the app.
   * A participant with role='trustee' returns 'trustee'.
   * Every other participant — heir-admin (captain) or ordinary heir — returns 'heir'.
   * The heir-admin is intentionally NOT distinguished as 'pr' anymore: under the
   * current language, they are simply an heir wearing the captain hat, and the
   * audit trail records what they did as an heir, not as a fiduciary.
   */
  private async roleOf(actorId: number | null): Promise<"captain" | "heir" | "trustee"> {
    if (actorId === null) return "captain";
    const all = await storage.listParticipants();
    const p = all.find((x) => x.id === actorId);
    if (!p) return "heir";
    if (p.role === "trustee") return "trustee";
    if (p.role === "representative") {
      // A representative acts on behalf of another participant. For the
      // audit trail we record the represented person's role, not the
      // representative's own — an heir's representative counts as an
      // heir action; a trustee's representative counts as a trustee
      // action.
      const represented = all.find((x) => x.id === p.representsParticipantId);
      if (represented?.role === "trustee") return "trustee";
      return "heir";
    }
    return "heir";
  }

  private async requireItem(itemId: number): Promise<Item> {
    const item = db.select().from(items).where(eq(items.id, itemId)).get();
    if (!item) notFound("Item");
    return item!;
  }

  /* ================================================================ */
  /* Valuations                                                        */
  /* ================================================================ */

  async listValuations(itemId: number): Promise<ItemValuation[]> {
    return db
      .select()
      .from(itemValuations)
      .where(eq(itemValuations.itemId, itemId))
      .orderBy(desc(itemValuations.createdAt))
      .all();
  }

  private async latestValuation(itemId: number): Promise<ItemValuation | null> {
    const rows = await this.listValuations(itemId);
    return rows[0] ?? null;
  }

  private async approvedValuation(itemId: number): Promise<ItemValuation | null> {
    const row = db
      .select()
      .from(itemValuations)
      .where(and(eq(itemValuations.itemId, itemId), eq(itemValuations.status, "approved")))
      .orderBy(desc(itemValuations.createdAt))
      .get();
    return row ?? null;
  }

  async addValuation(
    itemId: number,
    input: {
      value: number;
      valueLow?: number | null;
      valueHigh?: number | null;
      source: string;
      status?: string;
      notes?: string;
      attachmentUrl?: string | null;
    },
    actorId: number | null,
  ): Promise<ItemValuation> {
    const item = await this.requireItem(itemId);
    const role = await this.roleOf(actorId);
    const stateBefore = item.highValueState;

    const row = db
      .insert(itemValuations)
      .values({
        sessionId: item.sessionId,
        itemId,
        value: input.value,
        valueLow: input.valueLow ?? null,
        valueHigh: input.valueHigh ?? null,
        source: input.source,
        status: input.status ?? "estimated",
        notes: input.notes ?? "",
        attachmentUrl: input.attachmentUrl ?? null,
        createdByParticipantId: actorId,
        createdAt: Date.now(),
      })
      .returning()
      .get();

    // A fresh valuation always becomes the estate's best current estimate,
    // even before it's approved. Approval is a separate, captain-only step that
    // locks it in for final accounting.
    const patch: Partial<Item> = {
      estimatedValue: input.value,
      valueSource: input.source,
    };
    if (item.highValueState === "normal" || item.highValueState === "flagged_high_value") {
      patch.highValueState = "awaiting_value_review";
    }
    db.update(items).set(patch).where(eq(items.id, itemId)).run();
    const updated = await this.requireItem(itemId);

    await this.audit({
      sessionId: item.sessionId,
      itemId,
      eventType: "valuation_added",
      payload: { valuationId: row.id, value: input.value, source: input.source },
      stateBefore,
      stateAfter: updated.highValueState,
      valueAtEvent: input.value,
      valueStatusAtEvent: row.status,
      actorParticipantId: actorId,
      actorRole: role,
    });

    return row;
  }

  /**
   * Marks one valuation row approved, supersedes every other non-superseded
   * row for the item, and writes the approved value onto `items`
   * (approvedValue, valueStatus='approved', valuationDate). captain-only — enforced
   * by the router, not here (this class trusts its caller for authorization
   * and only re-validates data integrity).
   */
  async approveValuation(id: number, actorId: number | null): Promise<ItemValuation> {
    const target = db.select().from(itemValuations).where(eq(itemValuations.id, id)).get();
    if (!target) notFound("Valuation");
    const item = await this.requireItem(target!.itemId);
    const role = await this.roleOf(actorId);
    const stateBefore = item.highValueState;
    const now = Date.now();

    // Supersede every other currently-active valuation for this item.
    const siblings = db
      .select()
      .from(itemValuations)
      .where(and(eq(itemValuations.itemId, target!.itemId), isNull(itemValuations.supersededAt)))
      .all();
    for (const s of siblings) {
      if (s.id === id) continue;
      db.update(itemValuations)
        .set({ supersededAt: now, supersededByValuationId: id })
        .where(eq(itemValuations.id, s.id))
        .run();
      await this.audit({
        sessionId: item.sessionId,
        itemId: target!.itemId,
        eventType: "valuation_superseded",
        payload: { valuationId: s.id, supersededBy: id },
        stateBefore: item.highValueState,
        stateAfter: item.highValueState,
        valueAtEvent: s.value,
        valueStatusAtEvent: s.status,
        actorParticipantId: actorId,
        actorRole: role,
      });
    }

    const approved = db
      .update(itemValuations)
      .set({ status: "approved" })
      .where(eq(itemValuations.id, id))
      .returning()
      .get();

    db.update(items)
      .set({
        approvedValue: approved.value,
        estimatedValue: approved.value,
        valueSource: approved.source,
        valueStatus: "approved",
        valuationDate: now,
      })
      .where(eq(items.id, target!.itemId))
      .run();
    const updated = await this.requireItem(target!.itemId);

    await this.audit({
      sessionId: item.sessionId,
      itemId: target!.itemId,
      eventType: "valuation_approved",
      payload: { valuationId: id, value: approved.value },
      stateBefore,
      stateAfter: updated.highValueState,
      valueAtEvent: approved.value,
      valueStatusAtEvent: "approved",
      actorParticipantId: actorId,
      actorRole: role,
    });

    return approved;
  }

  /** Marks a valuation disputed. Does not touch other rows. */
  async disputeValuation(
    id: number,
    reason: string,
    actorId: number | null,
  ): Promise<ItemValuation> {
    const target = db.select().from(itemValuations).where(eq(itemValuations.id, id)).get();
    if (!target) notFound("Valuation");
    const item = await this.requireItem(target!.itemId);
    const role = await this.roleOf(actorId);

    const disputed = db
      .update(itemValuations)
      .set({ status: "disputed" })
      .where(eq(itemValuations.id, id))
      .returning()
      .get();

    // If this was the item's currently-approved value basis, the item's
    // value status must reflect the dispute so finalization re-blocks.
    if (item.valueStatus === "approved" && item.approvedValue === target!.value) {
      db.update(items).set({ valueStatus: "disputed" }).where(eq(items.id, target!.itemId)).run();
    }

    await this.audit({
      sessionId: item.sessionId,
      itemId: target!.itemId,
      eventType: "valuation_disputed",
      payload: { valuationId: id, reason },
      stateBefore: item.highValueState,
      stateAfter: item.highValueState,
      valueAtEvent: target!.value,
      valueStatusAtEvent: "disputed",
      actorParticipantId: actorId,
      actorRole: role,
      reason,
    });

    return disputed;
  }


  /* ================================================================ */
  /* v14 Trustee Handoff — flag for appraisal                          */
  /* ================================================================ */

  /**
   * Any authenticated participant (heir or captain) may flag an item for appraisal.
   * Sets needsAppraisal=true and, from state 'normal', transitions to
   * 'flagged_high_value'. The item stays in the ranked-draft pool — flagging
   * only records that an appraised value should be attached before the trustee
   * handoff. Idempotent: flagging an already-flagged item is a no-op that
   * still writes an audit row noting the caller and reason.
   */
  async flagForAppraisal(
    itemId: number,
    actorId: number | null,
    reason: string = "",
  ): Promise<Item> {
    const item = await this.requireItem(itemId);
    const role = await this.roleOf(actorId);
    const stateBefore = item.highValueState;

    const patch: Partial<Item> = {};
    if (!item.needsAppraisal) patch.needsAppraisal = true;
    if (item.highValueState === "normal") patch.highValueState = "flagged_high_value";
    if (Object.keys(patch).length > 0) {
      db.update(items).set(patch).where(eq(items.id, itemId)).run();
    }
    const updated = await this.requireItem(itemId);

    await this.audit({
      sessionId: item.sessionId,
      itemId,
      eventType: "flagged",
      payload: { reason, wasAlreadyFlagged: item.needsAppraisal },
      stateBefore,
      stateAfter: updated.highValueState,
      valueAtEvent: item.approvedValue,
      valueStatusAtEvent: item.valueStatus,
      actorParticipantId: actorId,
      actorRole: role,
      reason,
    });

    return updated;
  }

  /* ================================================================ */
  /* v14 Trustee Handoff — Method Agreement (up-front buy-in)          */
  /* ================================================================ */

  /**
   * Records one heir's Method Agreement signature for the current session.
   * Immutable once written. The current agreement text is snapshotted onto
   * the row so future edits to the constant never retroactively change what
   * an heir agreed to. Throws FiduciaryError(409) on duplicate.
   */
  async recordMethodAgreement(input: {
    sessionId: number;
    participantId: number;
    signatureMethod?: "magic_link" | "in_person";
    magicLinkTokenId?: number | null;
    clientIp?: string | null;
    clientUserAgent?: string | null;
  }): Promise<MethodAgreement> {
    const session = await storage.getSession();
    if (session.captainParticipantId == null) {
      throw new FiduciaryError(
        "No captain is set for this session. Nothing to agree to yet.",
        409,
      );
    }
    const captainId = session.captainParticipantId;
    const roster = await storage.listParticipants();
    const captain = roster.find((p) => p.id === captainId);
    if (!captain) {
      throw new FiduciaryError(
        "The named captain is not on the roster.",
        409,
      );
    }

    // Uniqueness is now (session, heir, captain). Signing a fresh mandate
    // for a new captain writes a new row; re-signing the same captain
    // twice is still forbidden and returns 409.
    const existing = db
      .select()
      .from(methodAgreements)
      .where(
        and(
          eq(methodAgreements.sessionId, input.sessionId),
          eq(methodAgreements.participantId, input.participantId),
          eq(methodAgreements.captainParticipantId, captainId),
        ),
      )
      .get();
    if (existing) {
      throw new FiduciaryError(
        "Method Agreement already recorded for this heir under the current captain. Agreements are immutable.",
        409,
      );
    }

    const renderedText = renderMethodAgreementText(captain.name);

    const row = db
      .insert(methodAgreements)
      .values({
        sessionId: input.sessionId,
        participantId: input.participantId,
        agreedAt: Date.now(),
        agreementVersion: CURRENT_METHOD_AGREEMENT_VERSION,
        agreementTextSnapshot: renderedText,
        signatureMethod: input.signatureMethod ?? "magic_link",
        magicLinkTokenId: input.magicLinkTokenId ?? null,
        clientIp: input.clientIp ?? null,
        clientUserAgent: input.clientUserAgent ?? null,
        captainParticipantId: captainId,
      })
      .returning()
      .get();

    // Audit against itemId 0 (session-scoped, no item involved). The
    // highValueAuditLog schema requires an itemId column; using 0 keeps the
    // append-only story unified without polluting per-item logs.
    await this.audit({
      sessionId: input.sessionId,
      itemId: 0,
      eventType: "method_agreement_signed",
      payload: {
        agreementId: row.id,
        version: row.agreementVersion,
        participantId: input.participantId,
      },
      stateBefore: "n/a",
      stateAfter: "n/a",
      valueAtEvent: null,
      valueStatusAtEvent: null,
      actorParticipantId: input.participantId,
      actorRole: "heir",
    });

    return row;
  }

  async listMethodAgreements(sessionId: number): Promise<MethodAgreement[]> {
    return db
      .select()
      .from(methodAgreements)
      .where(eq(methodAgreements.sessionId, sessionId))
      .orderBy(desc(methodAgreements.agreedAt))
      .all();
  }

  /**
   * True when every non-admin heir on the session has a Method Agreement
   * row FOR THE CURRENT CAPTAIN. Used both by the ranking-phase gate and
   * by finalize(). A captain change invalidates existing agreements: old
   * rows stay on the record (audit trail) but no longer count. Every
   * heir must sign a fresh row naming the new captain before the game
   * resumes.
   */
  async allHeirsHaveMethodAgreement(sessionId: number): Promise<boolean> {
    const session = await storage.getSession();
    const captainId = session.captainParticipantId;
    if (captainId == null) return false;
    const roster = await storage.listParticipants();
    const heirs = roster.filter((p) => !p.administersOnly);
    if (heirs.length === 0) return false;
    const agreements = await this.listMethodAgreements(sessionId);
    const signedForCaptain = new Set(
      agreements
        .filter((a) => a.captainParticipantId === captainId)
        .map((a) => a.participantId),
    );
    return heirs.every((h) => signedForCaptain.has(h.id));
  }

  /* ================================================================ */
  /* Snapshot export — the graceful exit                              */
  /* ================================================================ */

  /**
   * Read-only "state as of now" for any signed-in participant, callable
   * in any phase (roster, intake, ranking, drafting, groupings, done,
   * paused). Not a finalization, not a decision — just the data. The
   * heirs use this when cooperation collapses: they stop using the app,
   * hand the snapshot to the trustee, and the trustee proceeds outside
   * the app by whatever means they would have used without it.
   *
   * Contents are a superset of the Record of Decisions: everything that
   * document has, plus rankings-in-progress, all method-agreement rows
   * (including superseded ones from earlier captain eras), and the full
   * audit log. Everything is a plain JSON value so the client can save
   * or print it verbatim.
   */
  async getSnapshot(sessionId: number): Promise<SessionSnapshot> {
    const session = await storage.getSession();
    const roster = await storage.listParticipants();
    const captain =
      session.captainParticipantId != null
        ? roster.find((p) => p.id === session.captainParticipantId) ?? null
        : null;

    const allItems = db
      .select()
      .from(items)
      .where(eq(items.sessionId, sessionId))
      .all();

    // Rankings for every heir, whether or not the ranking phase is open.
    // A snapshot taken during ranking captures whatever partial state the
    // heirs have entered so the trustee can see who ranked what.
    const rankings = await storage.listRankings();

    const agreements = await this.listMethodAgreements(sessionId);

    const audit = db
      .select()
      .from(highValueAuditLog)
      .where(eq(highValueAuditLog.sessionId, sessionId))
      .orderBy(highValueAuditLog.createdAt)
      .all();

    return {
      generatedAt: Date.now(),
      session: {
        id: session.id,
        name: session.name,
        phase: session.phase,
        lifecycleState: session.state,
        captainParticipantId: session.captainParticipantId ?? null,
        captainName: captain?.name ?? null,
        inventoryCompletedAt: session.inventoryCompletedAt ?? null,
        rankingOpenedAt: session.rankingOpenedAt ?? null,
      },
      roster,
      items: allItems,
      rankings,
      methodAgreements: agreements,
      currentMethodAgreementText: renderMethodAgreementText(
        captain?.name ?? "the captain",
      ),
      currentMethodAgreementVersion: CURRENT_METHOD_AGREEMENT_VERSION,
      auditLog: audit,
    };
  }

  /* ================================================================ */
  /* v14 Trustee Handoff — Record of Decisions                        */
  /* ================================================================ */

  /**
   * Builds the trustee-facing document: every item in the session, who it was
   * awarded to, appraised value if any, and pending-appraisal markers for
   * items whose escalating heir has not yet supplied a value. Read-only; no
   * side effects, no audit rows.
   */
  async generateRecordOfDecisions(sessionId: number): Promise<RecordOfDecisions> {
    const session = await storage.getSession();
    const roster = await storage.listParticipants();
    const captain = roster.find((p) => p.isAdmin) ?? null;
    const heirs = roster.filter((p) => !p.administersOnly);
    const agreements = await this.listMethodAgreements(sessionId);
    const agreedAtByParticipant = new Map<number, number>(
      agreements.map((a) => [a.participantId, a.agreedAt]),
    );

    const allItems = db.select().from(items).where(eq(items.sessionId, sessionId)).all();
    // Pre-compute a flag-audit lookup: the first heir to flag an item is the
    // "escalating heir" shown on the trustee document.
    const flagRows = db
      .select()
      .from(highValueAuditLog)
      .where(and(eq(highValueAuditLog.sessionId, sessionId), eq(highValueAuditLog.eventType, "flagged")))
      .orderBy(highValueAuditLog.createdAt)
      .all();
    const firstFlaggerByItem = new Map<number, number | null>();
    for (const r of flagRows) {
      if (!firstFlaggerByItem.has(r.itemId)) firstFlaggerByItem.set(r.itemId, r.actorParticipantId ?? null);
    }

    const rowsOut: RecordOfDecisionsItem[] = [];
    let appraisedCount = 0;
    let pendingCount = 0;
    let totalAppraised = 0;

    for (const item of allItems) {
      const recipientId = item.provisionalRecipientId ?? null;
      const recipient = recipientId != null ? roster.find((p) => p.id === recipientId) : null;
      const appraised = item.valueStatus === "approved" ? item.approvedValue : null;
      const pending = item.needsAppraisal && appraised == null;
      if (appraised != null) {
        appraisedCount += 1;
        totalAppraised += appraised;
      }
      if (pending) pendingCount += 1;

      const flaggerId = firstFlaggerByItem.get(item.id) ?? null;
      const flagger = flaggerId != null ? roster.find((p) => p.id === flaggerId) : null;

      rowsOut.push({
        id: item.id,
        name: item.name,
        room: item.room ?? null,
        category: (item as any).category ?? null,
        awardedToParticipantId: recipientId,
        awardedToName: recipient?.name ?? null,
        needsAppraisal: item.needsAppraisal,
        appraisedValue: appraised,
        valueSource: item.valueSource ?? null,
        valuationDate: item.valuationDate ?? null,
        pendingAppraisal: pending,
        escalatingParticipantId: pending ? flaggerId : null,
        escalatingParticipantName: pending ? flagger?.name ?? null : null,
      });
    }

    /* ------------------------------------------------------------------ */
    /* Additive: per-stage sections + escalated-to-trustee bucket          */
    /* ------------------------------------------------------------------ */
    // Latest estimate per item (chronological head of item_valuations). No
    // "approved" concept in the reshaped report; every value is pre-appraisal.
    const valuationRows = db
      .select()
      .from(itemValuations)
      .where(eq(itemValuations.sessionId, sessionId))
      .orderBy(desc(itemValuations.createdAt))
      .all();
    const latestEstimateByItem = new Map<number, number>();
    for (const v of valuationRows) {
      if (!latestEstimateByItem.has(v.itemId)) {
        latestEstimateByItem.set(v.itemId, v.value);
      }
    }
    const estimateOf = (item: Item): number | null => {
      const fromValuation = latestEstimateByItem.get(item.id);
      if (fromValuation != null) return fromValuation;
      if (item.valueStatus === "approved" && item.approvedValue != null) return item.approvedValue;
      return null;
    };

    // Escalation source: read from appraisal_flags when present,
    // otherwise infer from the audit log (legacy pre-reshape rows).
    const nominationRows = db
      .select()
      .from(appraisalFlags)
      .where(eq(appraisalFlags.sessionId, sessionId))
      .all();
    const nominationByItem = new Map<number, (typeof nominationRows)[number]>();
    for (const n of nominationRows) {
      const existing = nominationByItem.get(n.itemId);
      // Prefer an ACTIVE (non-reverted) row over any reverted one; among rows
      // of the same reversion state, newest wins.
      if (!existing) {
        nominationByItem.set(n.itemId, n);
        continue;
      }
      const existingActive = existing.revertedAt == null;
      const nActive = n.revertedAt == null;
      if (nActive && !existingActive) nominationByItem.set(n.itemId, n);
      else if (nActive === existingActive && n.id > existing.id) nominationByItem.set(n.itemId, n);
    }

    // Groupings for stage labeling.
    const groupingRows = db
      .select()
      .from(groupings)
      .where(eq(groupings.sessionId, sessionId))
      .all();
    const groupingById = new Map<number, (typeof groupingRows)[number]>();
    for (const g of groupingRows) groupingById.set(g.id, g);

    // Bucket items by (stage, heir). Escalated items skip staging.
    type StageBucket = {
      groupingId: number | null;
      groupingName: string;
      groupingType: string;
      byHeir: Map<number, RoDStageLine[]>;
    };
    const stagesMap = new Map<number | null, StageBucket>();
    const ensureStage = (item: Item): StageBucket => {
      const gid = item.groupingId ?? null;
      const existing = stagesMap.get(gid);
      if (existing) return existing;
      const g = gid != null ? groupingById.get(gid) : null;
      const bucket: StageBucket = {
        groupingId: gid,
        groupingName: g?.name ?? "General round",
        groupingType: g?.type ?? "general",
        byHeir: new Map<number, RoDStageLine[]>(),
      };
      stagesMap.set(gid, bucket);
      return bucket;
    };

    const escalatedItems: RoDEscalatedItem[] = [];
    const unassignedItems: RoDStageLine[] = [];

    for (const item of allItems) {
      const est = estimateOf(item);
      const line: RoDStageLine = {
        itemId: item.id,
        itemName: item.name,
        room: item.room ?? null,
        category: (item as any).category ?? null,
        estimate: est,
      };

      // Escalated items land in the trustee bucket, not in a stage section.
      // We consider the ACTIVE nomination row (revertedAt == null); a reverted
      // row does NOT keep an item in the escalated bucket.
      const activeNom = nominationByItem.get(item.id);
      const isActivelyEscalated =
        (item.status === "needs_appraisal" || item.needsAppraisal) &&
        (activeNom == null || activeNom.revertedAt == null);
      if (isActivelyEscalated) {
        let source: "heir" | "owner" | "ai" | "unknown" = "unknown";
        let label = "Flagged for appraisal";
        if (activeNom?.flaggedBySource === "heir") {
          source = "heir";
          const heir = activeNom.flaggedByParticipantId != null
            ? roster.find((p) => p.id === activeNom.flaggedByParticipantId)
            : null;
          label = heir ? `Heir: ${heir.name}` : "Heir";
          if (activeNom.reason) label += ` (${activeNom.reason})`;
        } else if (activeNom?.flaggedBySource === "owner") {
          source = "owner";
          label = activeNom.reason ? `Owner: ${activeNom.reason}` : "Owner (via Registry)";
        } else if (activeNom?.flaggedBySource === "ai") {
          source = "ai";
          label = activeNom.reason ? `AI: ${activeNom.reason}` : "AI";
        } else {
          // No nomination row at all — e.g. an item marked needsAppraisal by
          // an older code path (fiduciary flagForAppraisal). Fall back to
          // the audit log first flagger.
          const flaggerId = firstFlaggerByItem.get(item.id) ?? null;
          const flagger = flaggerId != null ? roster.find((p) => p.id === flaggerId) : null;
          if (flagger) {
            source = "heir";
            label = `Heir: ${flagger.name}`;
          }
        }

        escalatedItems.push({
          itemId: item.id,
          itemName: item.name,
          room: item.room ?? null,
          category: (item as any).category ?? null,
          estimate: est,
          escalationSource: source,
          escalationSourceLabel: label,
          recipientHint: (item as any).recipientHint ?? null,
        });
        continue;
      }

      const recipientId = item.provisionalRecipientId ?? null;
      if (recipientId == null) {
        unassignedItems.push(line);
        continue;
      }

      const bucket = ensureStage(item);
      const list = bucket.byHeir.get(recipientId) ?? [];
      list.push(line);
      bucket.byHeir.set(recipientId, list);
    }

    // Order stages: named groupings first (by id ascending, matching creation
    // order), general round last.
    const stageKeys: (number | null)[] = [];
    stagesMap.forEach((_v, k) => stageKeys.push(k));
    const orderedStageKeys: (number | null)[] = [
      ...stageKeys.filter((k): k is number => k !== null).sort((a, b) => a - b),
      ...(stagesMap.has(null) ? [null] : []),
    ];

    const stagesOut: RoDStageSection[] = orderedStageKeys.map((gid) => {
      const bucket = stagesMap.get(gid)!;
      const byHeir = heirs
        .map((h) => {
          const rows = bucket.byHeir.get(h.id) ?? [];
          const subtotal = rows.reduce((sum, r) => sum + (r.estimate ?? 0), 0);
          return {
            heirId: h.id,
            heirName: h.name,
            items: rows,
            subtotalEstimate: subtotal,
          };
        })
        .filter((entry) => entry.items.length > 0);
      const stageTotal = byHeir.reduce((sum, e) => sum + e.subtotalEstimate, 0);
      return {
        groupingId: bucket.groupingId,
        groupingName: bucket.groupingName,
        groupingType: bucket.groupingType,
        byHeir,
        stageTotalEstimate: stageTotal,
      };
    });

    const escalatedTotal = escalatedItems.reduce((sum, e) => sum + (e.estimate ?? 0), 0);
    const escalatedWithoutEstimate = escalatedItems.filter((e) => e.estimate == null).length;

    return {
      session: { id: session.id, name: session.name, estateName: session.estateName ?? null },
      captain: { id: captain?.id ?? null, name: captain?.name ?? null },
      heirs: heirs.map((h) => ({
        id: h.id,
        name: h.name,
        methodAgreedAt: agreedAtByParticipant.get(h.id) ?? null,
      })),
      items: rowsOut,
      stages: stagesOut,
      escalatedToTrustee: {
        items: escalatedItems,
        totalEstimate: escalatedTotal,
        itemsWithoutEstimate: escalatedWithoutEstimate,
      },
      unassigned: unassignedItems,
      totals: {
        itemCount: rowsOut.length,
        appraisedCount,
        pendingAppraisalCount: pendingCount,
        totalAppraisedValue: totalAppraised,
      },
      generatedAt: Date.now(),
    };
  }
}

export const fiduciary = new FiduciaryStorage();
