import { chromium } from "playwright";
import fs from "fs";
import { execSync } from "child_process";

const OUT = "/home/user/workspace/v7a_screenshots";
fs.mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:5000";

const j = async (m, u, b) => {
  const r = await fetch(BASE + u, {
    method: m,
    headers: { "content-type": "application/json" },
    body: b !== undefined ? JSON.stringify(b) : undefined,
  });
  let d = null;
  try { d = await r.json(); } catch {}
  return { status: r.status, d };
};

// Seed a clean session with a PR + heirs.
await j("POST", "/api/qa/seed", {
  estateName: "Lifecycle Screenshot Estate",
  prName: "Pat",
  prIsHeir: false,
  heirs: ["Alex", "Bea", "Chris"],
  phase: "intake",
});
const participants = (await j("GET", "/api/participants")).d;
const pat = participants.find((p) => p.isAdmin);
const alex = participants.find((p) => p.name === "Alex");

const browser = await chromium.launch({ headless: true });

async function shot(name, { width, height }, fn) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await fn(page, context);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log("saved", name);
  await context.close();
}

/**
 * Sign in via the real login page tiles (in-memory UserProvider, no storage).
 * Signing in triggers the app's own client-side (wouter) navigation to the
 * landing route — a subsequent `page.goto()` would force a full reload and
 * wipe the in-memory userId, so callers must NOT re-navigate after this.
 */
async function signInAsAdmin(page, adminId) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.locator(`[data-testid="button-signin-admin-${adminId}"]`).click();
  await page.waitForTimeout(800);
}
async function signInAsHeir(page, heirId) {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  await page.locator(`[data-testid="tile-heir-${heirId}"]`).click();
  await page.waitForTimeout(800);
}
/** Client-side nav via the sidebar link, preserving in-memory userId. */
async function clickNav(page, testid) {
  await page.locator(`[data-testid="${testid}"]`).click();
  await page.waitForTimeout(800);
}

/* 1. SessionLifecycleCard — Active state, admin page, PR view */
// signInAsAdmin already lands on /administration, which renders AdminPage.
await shot("01_lifecycle_card_active_1440", { width: 1440, height: 900 }, async (page) => {
  await signInAsAdmin(page, pat.id);
  await page.locator('[data-testid="card-session-lifecycle"]').scrollIntoViewIfNeeded().catch(() => {});
});

await shot("01b_lifecycle_card_active_390", { width: 390, height: 844 }, async (page) => {
  await signInAsAdmin(page, pat.id);
  await page.locator('[data-testid="card-session-lifecycle"]').scrollIntoViewIfNeeded().catch(() => {});
});

/* 2. Pause the estate via API, then screenshot SessionLifecycleCard Paused (reason + live counter) */
await j("POST", "/api/session/lifecycle/pause", {
  participantId: pat.id,
  reason: "Waiting on the appraiser's report before we continue with distribution.",
});
await new Promise((r) => setTimeout(r, 2500)); // let the live "paused for X" counter tick past 0

await shot("02_lifecycle_card_paused_1440", { width: 1440, height: 900 }, async (page) => {
  await signInAsAdmin(page, pat.id);
  await page.waitForTimeout(700);
  await page.locator('[data-testid="card-session-lifecycle"]').scrollIntoViewIfNeeded().catch(() => {});
});

await shot("02b_lifecycle_card_paused_390", { width: 390, height: 844 }, async (page) => {
  await signInAsAdmin(page, pat.id);
  await page.waitForTimeout(700);
  await page.locator('[data-testid="card-session-lifecycle"]').scrollIntoViewIfNeeded().catch(() => {});
});

/* 3. PausedBanner — heir full-page overlay */
// signInAsHeir already lands on /next for a non-admin heir.
await shot("03_paused_banner_heir_1440", { width: 1440, height: 900 }, async (page) => {
  await signInAsHeir(page, alex.id);
  await page.waitForTimeout(700);
});

await shot("03b_paused_banner_heir_390", { width: 390, height: 844 }, async (page) => {
  await signInAsHeir(page, alex.id);
  await page.waitForTimeout(700);
});

/* 4. ResumeDialog with extend-window input (needs pause >= 24h) */
let backdateOut = "";
try {
  backdateOut = execSync("node qa_backdate_pause.mjs 50", { cwd: "/home/user/workspace/estate-distribution-manager" }).toString();
} catch (e) {
  backdateOut = String(e);
}
console.log("backdate result:", backdateOut.trim());

await shot("04_resume_dialog_extend_1440", { width: 1440, height: 900 }, async (page) => {
  await signInAsAdmin(page, pat.id);
  await page.waitForTimeout(700);
  const resumeBtn = page.locator('[data-testid="button-resume-estate"]').first();
  await resumeBtn.click();
  await page.waitForTimeout(600);
});

await shot("04b_resume_dialog_extend_390", { width: 390, height: 844 }, async (page) => {
  await signInAsAdmin(page, pat.id);
  await page.waitForTimeout(700);
  const resumeBtn = page.locator('[data-testid="button-resume-estate"]').first();
  await resumeBtn.click();
  await page.waitForTimeout(600);
});

await browser.close();

// Leave the estate resumed/active so the server isn't left in a paused state.
await j("POST", "/api/session/lifecycle/resume", { participantId: pat.id });

console.log("ALL_SCREENSHOTS_DONE");
