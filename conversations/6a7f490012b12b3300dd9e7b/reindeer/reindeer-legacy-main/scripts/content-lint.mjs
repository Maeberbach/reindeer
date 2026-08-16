#!/usr/bin/env node
/**
 * Content lint: catch the words we deliberately removed from the user-visible
 * surface of both apps. The banned words are legitimate legal terms — they
 * just aren't what THIS suite calls them anymore. Public copy uses one word:
 * TRUSTEE. Role words in code identifiers are fine; strings shown to the user
 * are not.
 *
 * Banned as visible strings:
 *   - "Personal Representative" / "personal representative" (as a role name)
 *   - "Fiduciary" / "fiduciary" (as a role/person; the concept "legal duty"
 *     is fine but we tightened the copy anyway)
 *   - Standalone "PR" as a role label in visible strings
 *
 * The lint scans only user-visible surfaces:
 *   - React/TSX components (apps/legacy-fair-choice/client/src)
 *   - Registry client + preview app.js (visible copy only, not identifiers)
 *   - Shared print/template packages
 *
 * It skips:
 *   - Route paths (/api/fiduciary/*) — wire values, kept for compatibility
 *   - JSDoc / code comments
 *   - Historical docs (docs/handoffs, docs/decisions, docs/fair-choice-audit)
 *   - Selftest files (they intentionally test rejection of these words)
 *
 * Usage: node scripts/content-lint.mjs
 * Exit code: 0 on clean, 1 on violations.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Directories to scan for visible-copy violations.
const SCAN = [
  "apps/legacy-fair-choice/client/src",
  "apps/legacy-registry/client",
  "apps/legacy-registry/preview",
  "packages/legacy-print-feature/src/templates",
];

// Files/dirs to skip entirely (paths relative to ROOT).
const SKIP_PATHS = [
  "docs/handoffs",
  "docs/decisions",
  "docs/fair-choice-audit.md",
  "node_modules",
  ".git",
  "apps/legacy-fair-choice/_scaffold",
  "apps/legacy-fair-choice/server/trustee/selftest.mts",
  "apps/legacy-fair-choice/server/fiduciary/selftest.mts",
];

// Extensions to lint.
const EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".mts", ".jsx", ".html"]);

// Case-insensitive match for banned tokens in visible strings.
// The lint fires only on strings between quotes / JSX text / template literals.
const BANNED = [
  { name: "personal representative", re: /personal\s+representative/i },
  { name: "fiduciary", re: /\bfiduciar(y|ies)\b/i },
];

// Approved contexts (whole line matched) where the token is allowed —
// disclosure lines that explain "your legal documents may say X".
const ALLOW_CONTEXT_RES = [
  /also called personal representative/i,
  /(may|might)\s+.{0,20}\s*(name|call)\s+.{0,60}\s*personal representative/i,
  /the app calls them.{0,80}trustee/i,
];

// Also flag standalone "PR" in visible text (not "PRE" / "PROPERTY" etc.).
// This is stricter: only match when it's flanked by punctuation/space AND
// appears inside a quoted string or JSX text.
const STANDALONE_PR = /\bPR\b/;

function shouldSkip(path) {
  const rel = relative(ROOT, path);
  return SKIP_PATHS.some((s) => rel === s || rel.startsWith(s + "/"));
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (shouldSkip(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(extname(p))) yield p;
  }
}

// Extract lines that likely contain user-visible strings.
// Heuristic: match anything inside quotes, and JSX text between > and <.
function visibleStringsFrom(line) {
  const out = [];
  // Skip JSDoc / block comments starting with *, //, or containing /**.
  const trimmed = line.trim();
  if (
    trimmed.startsWith("*") ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("* ") ||
    trimmed.startsWith("/**")
  )
    return out;

  // Grab double-quoted, single-quoted, and backtick strings (naive but ok).
  const stringRe = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g;
  let m;
  while ((m = stringRe.exec(line)) !== null) out.push(m[0]);

  // Grab JSX text between > and < on the same line.
  const jsxRe = />([^<>]{2,})</g;
  while ((m = jsxRe.exec(line)) !== null) out.push(m[1]);

  return out;
}

function isAllowedContext(fullLine) {
  return ALLOW_CONTEXT_RES.some((re) => re.test(fullLine));
}

let violations = [];

for (const sub of SCAN) {
  const dir = join(ROOT, sub);
  try {
    statSync(dir);
  } catch {
    continue;
  }
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      // Skip route path lines (/api/fiduciary/*) — wire value.
      if (/\/api\/fiduciary\//.test(line)) return;
      const strings = visibleStringsFrom(line);
      if (strings.length === 0) return;
      for (const s of strings) {
        // Skip strings that are obviously code identifiers / URLs / testids:
        //   "/fiduciary", "@/pages/fiduciary", "link-nav-fiduciary",
        //   "queryKey-fiduciary", "pr-transfers" (query keys).
        const looksLikeIdentifier =
          /^["']?[@/][^\s"']*["']?$/.test(s) ||
          /^["'][\w-]+["']$/.test(s) ||
          /^["'][\w-]*\/[\w-/]*["']$/.test(s);
        if (looksLikeIdentifier) continue;
        for (const { name, re } of BANNED) {
          if (re.test(s) && !isAllowedContext(line)) {
            violations.push({
              file: relative(ROOT, file),
              lineNo: i + 1,
              banned: name,
              excerpt: s.slice(0, 120),
            });
          }
        }
        if (STANDALONE_PR.test(s) && !/\bPRE|PROOF|PROPERTY|PRINT/i.test(s)) {
          // Only flag when the substring looks like an isolated role label,
          // e.g. "Contact the PR" — we tolerate acronym-like PR inside PR-prefixed
          // words (queryKey names are already caught by the string-heuristic filter).
          if (/\b(the|a|your|our|any|by|to|from|contact|called|current|previous|new)\s+PR\b/i.test(s) ||
              /\bPR\b\s+(role|assist|assistance|handoff|hat|will|can|must|should|invited)/i.test(s)) {
            if (!isAllowedContext(line)) {
              violations.push({
                file: relative(ROOT, file),
                lineNo: i + 1,
                banned: "standalone 'PR'",
                excerpt: s.slice(0, 120),
              });
            }
          }
        }
      }
    });
  }
}

if (violations.length === 0) {
  console.log("content-lint: clean (0 visible-copy violations of banned role vocabulary).");
  process.exit(0);
}

console.error(`content-lint: ${violations.length} violation(s):\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.lineNo}  banned="${v.banned}"  in: ${v.excerpt}`);
}
process.exit(1);
