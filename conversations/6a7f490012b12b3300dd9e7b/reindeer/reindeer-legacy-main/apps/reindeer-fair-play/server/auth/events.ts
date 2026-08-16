/**
 * Append-only audit trail for authentication. Every sign-in, failed
 * attempt, sign-out, token issue, and revocation writes one row here. This
 * is what lets a future trustee or attorney reconstruct who signed in when,
 * without ever exposing a raw token or session secret (only `detail` free
 * text, which callers must keep free of secrets).
 */
import { randomUUID } from "node:crypto";
import { db, storage } from "../storage";
import { authEvents, type AuthEventKind } from "@shared/schema";

export async function recordAuthEvent(input: {
  participantId: number | null;
  kind: AuthEventKind;
  detail?: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<void> {
  const session = await storage.getSession();
  db.insert(authEvents)
    .values({
      id: randomUUID(),
      sessionId: session.id,
      participantId: input.participantId,
      kind: input.kind,
      detail: input.detail ?? "",
      ip: input.ip,
      userAgent: input.userAgent,
      createdAt: Date.now(),
    })
    .run();
}
