"use strict";
/*
 * Sanitise engine.
 *
 * Rules load from the `sanitise` table (id, find, replace) and are applied
 * in id order. Two kinds of rule:
 *
 *   - WORD rules (find is purely alphabetic, e.g. "speyed"): matched
 *     case-insensitively AND on word boundaries (\b), so a short find like
 *     "im" can't fire inside "simple"/"trim"/"swim"; the replacement
 *     mirrors the casing pattern the customer typed (speyed→spayed,
 *     Speyed→Spayed, SPEYED→SPAYED).
 *   - LITERAL rules (symbols, entities, e.g. curly quotes, &#39;): exact
 *     literal replacement.
 *
 * On top of the DB-driven rules there are two built-in fixes (below) that
 * can't be expressed as a `find`/`replace` row at all — see the comment
 * above each for why.
 *
 * The database is never modified — this is a read-time transform applied
 * before display, clipboard, sorting and similarity comparison.
 */

const db = require("./db");

const CACHE_MS = 60 * 1000;
let cache = { rules: [], loadedAt: 0 };

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchCase(repl, src) {
  if (src === src.toUpperCase() && /[A-Z]/.test(src)) return repl.toUpperCase();
  if (src === src.toLowerCase()) return repl.toLowerCase();
  if (
    src[0] === src[0].toUpperCase() &&
    src.slice(1) === src.slice(1).toLowerCase()
  )
    return repl[0].toUpperCase() + repl.slice(1).toLowerCase();
  return repl; // odd mixed casing — use replacement as stored
}

async function loadRules() {
  const now = Date.now();
  if (now - cache.loadedAt < CACHE_MS) return cache.rules;
  const rows = await db.query(
    "SELECT `find`, `replace` FROM sanitise ORDER BY id ASC"
  );
  cache = {
    loadedAt: now,
    rules: rows.map((r) => {
      const isWord = /^[a-z]+$/i.test(r.find);
      return {
        find: r.find,
        replace: r.replace,
        // \b...\b: word rules exist to fix a mistyped WORD, not a
        // substring — without the boundaries, a rule as short as "im"
        // would also rewrite the middle of "simple"/"trim"/"swim".
        regex: isWord ? new RegExp(`\\b${escapeRegex(r.find)}\\b`, "gi") : null,
      };
    }),
  };
  return cache.rules;
}

/*
 * UK postcode reformatting. Customers routinely paste addresses with the
 * postcode run together (TS182NH) or spaced wrong — this finds anything
 * shaped like a postcode and normalises it to "outward inward" with
 * exactly one space, regardless of what whitespace (if any) was there
 * already. Not expressible as a find/replace row: every postcode is a
 * different string, the "fix" is a position to insert a space at, not a
 * fixed pair of strings.
 *
 * Outward code: 1-2 letters, a digit, optionally one more letter/digit
 * (covers A9, A99, A9A, AA9, AA99, AA9A). Inward code: always digit +
 * 2 letters. Relies on regex backtracking to place the boundary
 * correctly (e.g. "E15PW" → outward "E1", inward "5PW", not outward
 * "E15" with no valid inward left) — this is the same shape used for
 * plain-text UK postcode detection elsewhere.
 */
const UK_POSTCODE = /\b([A-Za-z]{1,2}\d[A-Za-z\d]?)\s*(\d[A-Za-z]{2})\b/g;
function fixPostcodes(text) {
  return text.replace(UK_POSTCODE, (m, outward, inward) => `${outward} ${inward}`);
}

/*
 * "im" → "I'm". Needs its own pass rather than a DB word rule for two
 * reasons: (1) it needs \b boundaries — handled generically above now,
 * but (2) more importantly the replacement is grammatically FIXED-case
 * ("I'm", capital I, always) rather than case-mirrored like every other
 * word rule. matchCase()'s mirror-the-customer's-casing convention is
 * right for spelling fixes (speyed→spayed preserves whatever casing the
 * customer used) but wrong here: an all-lowercase "im" would mirror to
 * "i'm", which is still wrong — "I" is capitalised regardless of how the
 * customer typed it. \b keeps this off "simple"/"trim"/"swim"/"Kim"/etc,
 * and it's a no-op on text that's already correctly "I'm" (no bare "im"
 * substring to match).
 */
const IM_CONTRACTION = /\bim\b/gi;
function fixImContraction(text) {
  return text.replace(IM_CONTRACTION, "I'm");
}

function applyRules(text, rules) {
  if (text == null) return null;
  let out = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const rule of rules) {
    if (rule.regex) {
      out = out.replace(rule.regex, (m) => matchCase(rule.replace, m));
    } else {
      out = out.split(rule.find).join(rule.replace);
    }
  }
  out = fixImContraction(out);
  out = fixPostcodes(out);
  out = out.trim();
  return out === "" || out === "NULL" ? null : out;
}

async function sanitise(text) {
  const rules = await loadRules();
  return applyRules(text, rules);
}

module.exports = {
  sanitise,
  loadRules,
  applyRules,
  matchCase,
  fixPostcodes,
  fixImContraction,
};
