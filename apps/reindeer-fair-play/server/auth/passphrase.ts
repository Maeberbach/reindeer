/**
 * The Captain's passphrase: hashing, verification, and the
 * small amount of state the routes need.
 *
 * The passphrase exists for one reason — so the person administering the estate
 * can get back in on a second device without waiting on email. See
 * server/migrations/v12_representative_passphrase.ts for why that gap existed.
 *
 * Three properties this file is responsible for keeping:
 *
 *   1. The passphrase is never stored, logged, or returned. Only scrypt(pass,
 *      salt) and the salt go to the database.
 *   2. Verification is constant-time over the hash. A comparison that returns
 *      early on the first wrong byte leaks how much of a guess was right.
 *   3. A missing credential and a wrong passphrase are indistinguishable from
 *      outside. Otherwise the sign-in screen becomes a way to ask "does this
 *      estate have a representative passphrase yet", which is not a stranger's
 *      business.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db, storage } from "../storage";
import {
  representativeCredentials,
  CAPTAIN_PASSPHRASE_MIN_LENGTH,
  type RepresentativeCredential,
} from "@shared/schema";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * scrypt cost. N=2^15 with r=8 lands around a tenth of a second on modest
 * hardware — slow enough to make bulk guessing expensive, fast enough that an
 * elderly user pressing "Sign in" does not notice. maxmem must be raised
 * explicitly because Node's default ceiling (32 MB) is below what N=2^15
 * needs (128 * N * r ≈ 32 MB plus overhead), and the call would otherwise
 * throw rather than run slowly.
 */
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

/** The current hashing scheme. Stored per row so it can be changed later without locking anyone out. */
export const CURRENT_HASH_VERSION = 1;

export type PassphraseProblem = { message: string; status: number };

/**
 * Checks a proposed passphrase before it is hashed.
 *
 * Only length is enforced. Character-class rules ("one capital, one digit, one
 * symbol") push people towards short, hard-to-remember strings that are easier
 * to guess than a long plain sentence, and this app is used by people who will
 * not enjoy decoding a rejection message. Leading and trailing spaces are
 * trimmed, because they are invisible and would otherwise cause a sign-in that
 * fails for no visible reason — but interior spaces are kept, since a spaced
 * sentence is exactly the shape being encouraged.
 */
export function normalizePassphrase(raw: string): string {
  return raw.trim();
}

export function validatePassphrase(raw: string): PassphraseProblem | null {
  const pass = normalizePassphrase(raw);
  if (pass.length < CAPTAIN_PASSPHRASE_MIN_LENGTH) {
    return {
      status: 400,
      message: `Please use at least ${CAPTAIN_PASSPHRASE_MIN_LENGTH} characters. A short sentence you will remember works well.`,
    };
  }
  if (pass.length > 400) {
    return { status: 400, message: "That passphrase is too long. Please keep it under 400 characters." };
  }
  return null;
}

async function hashPassphrase(pass: string, saltHex: string): Promise<string> {
  const derived = await scrypt(pass, Buffer.from(saltHex, "hex"), KEY_LENGTH, SCRYPT_PARAMS);
  return derived.toString("hex");
}

/** The credential for the current estate, or null if none has been set. */
export async function getCredential(): Promise<RepresentativeCredential | null> {
  const session = await storage.getSession();
  return (
    db
      .select()
      .from(representativeCredentials)
      .where(eq(representativeCredentials.sessionId, session.id))
      .get() ?? null
  );
}

/** Whether this estate has a representative passphrase. captain-only information. */
export async function hasPassphrase(): Promise<boolean> {
  return (await getCredential()) !== null;
}

/**
 * Sets or replaces the representative's passphrase.
 *
 * `participantId` comes from the signed-in representative's session, never from
 * the request body. Replacing an existing passphrase updates the single row and
 * stamps `changedAt`, so the record shows the passphrase moved rather than
 * appearing to have always been the new one.
 */
export async function setPassphrase(input: {
  participantId: number;
  passphrase: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<{ created: boolean }> {
  const problem = validatePassphrase(input.passphrase);
  if (problem) throw Object.assign(new Error(problem.message), { status: problem.status });

  const pass = normalizePassphrase(input.passphrase);
  const session = await storage.getSession();
  const saltHex = randomBytes(SALT_BYTES).toString("hex");
  const hash = await hashPassphrase(pass, saltHex);
  const now = Date.now();
  const existing = await getCredential();

  if (existing) {
    db.update(representativeCredentials)
      .set({
        participantId: input.participantId,
        passphraseHash: hash,
        passphraseSalt: saltHex,
        hashVersion: CURRENT_HASH_VERSION,
        changedAt: now,
      })
      .where(eq(representativeCredentials.id, existing.id))
      .run();
    return { created: false };
  }

  db.insert(representativeCredentials)
    .values({
      sessionId: session.id,
      participantId: input.participantId,
      passphraseHash: hash,
      passphraseSalt: saltHex,
      hashVersion: CURRENT_HASH_VERSION,
      createdAt: now,
      createdIp: input.ip,
      createdUserAgent: input.userAgent,
      changedAt: null,
    })
    .run();
  return { created: true };
}

/** Removes the passphrase, putting the representative back on email-only sign-in. */
export async function clearPassphrase(): Promise<boolean> {
  const existing = await getCredential();
  if (!existing) return false;
  db.delete(representativeCredentials).where(eq(representativeCredentials.id, existing.id)).run();
  return true;
}

export type VerifyResult =
  | { ok: true; participantId: number }
  | { ok: false; reason: "no_credential" | "mismatch" | "not_representative" };

/**
 * Verifies a passphrase and reports who it signs in as.
 *
 * When no credential exists the work is still done against a throwaway salt
 * before returning. Skipping it would make "no passphrase set" answer in a
 * millisecond while a real check takes a hundred, and the difference is
 * measurable from outside — which would turn this route into a way to probe
 * whether an estate has been set up. Callers must map every failure reason to
 * the same message and the same status.
 */
export async function verifyPassphrase(raw: string): Promise<VerifyResult> {
  const pass = normalizePassphrase(raw);
  const credential = await getCredential();

  // Always do the same amount of work regardless of whether a credential exists,
  // so an attacker cannot tell from response timing whether a passphrase is set.
  const dummySalt = randomBytes(SALT_BYTES).toString("hex");
  const salt = credential ? credential.passphraseSalt : dummySalt;
  const candidate = await hashPassphrase(pass, salt);
  const a = Buffer.from(candidate, "hex");
  const b = credential ? Buffer.from(credential.passphraseHash, "hex") : a; // when no credential, compare to self (always matches, but we still return no_credential below)
  // Always call timingSafeEqual to keep timing constant; ignore length mismatch (scrypt output is fixed-length)
  const matches = a.length === b.length ? timingSafeEqual(a, b) : false;

  if (!credential) {
    return { ok: false, reason: "no_credential" };
  }

  if (!matches) {
    return { ok: false, reason: "mismatch" };
  }

  // The passphrase is the captain's, so confirm the row it points at
  // still holds that role. If the role was handed over and this credential was
  // left behind, it must not still open the door.
  const participant = (await storage.listParticipants()).find(
    (p) => p.id === credential.participantId,
  );
  if (!participant?.isAdmin) return { ok: false, reason: "not_representative" };

  return { ok: true, participantId: credential.participantId };
}
