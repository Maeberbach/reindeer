import { chromium } from "playwright";

const OUT = "/home/user/workspace/v7a_screenshots";
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

// Resume (script left it paused), then do a second pause/resume cycle so the
// history list has several rows to render.
const participants = (await j("GET", "/api/participants")).d;
const pat = participants.find((p) => p.isAdmin);
let lc = (await j("GET", "/api/session/lifecycle/state")).d;
if (lc.state === "paused") await j("POST", "/api/session/lifecycle/resume", { participantId: pat.id });
await j("POST", "/api/session/lifecycle/pause", { participantId: pat.id, reason: "Second pause for history screenshot" });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(600);
await page.locator(`[data-testid="button-signin-admin-${pat.id}"]`).click();
await page.waitForTimeout(800);
await page.locator('[data-testid="button-toggle-state-history"]').click();
await page.waitForTimeout(500);
await page.locator('[data-testid="card-session-lifecycle"]').scrollIntoViewIfNeeded().catch(() => {});
await page.screenshot({ path: `${OUT}/05_lifecycle_card_history_expanded_1440.png` });
console.log("saved 05_lifecycle_card_history_expanded_1440");

await browser.close();
await j("POST", "/api/session/lifecycle/resume", { participantId: pat.id });
console.log("DONE");
