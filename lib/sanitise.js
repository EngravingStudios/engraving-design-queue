"use strict";
/*
 * Sanitise engine.
 *
 * Rules load from the `sanitise` table (id, find, replace) and are applied
 * in id order. Two kinds of rule:
 *
 *   - WORD rules (find is purely alphabetic, e.g. "speyed"): matched
 *     case-insensitively; the replacement mirrors the casing pattern the
 *     customer typed (speyed→spayed, Speyed→Spayed, SPEYED→SPAYED).
 *   - LITERAL rules (symbols, entities, e.g. curly quotes, &#39;): exact
 *     literal replacement.
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
        regex: isWord ? new RegExp(escapeRegex(r.find), "gi") : null,
      };
    }),
  };
  return cache.rules;
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
  out = out.trim();
  return out === "" || out === "NULL" ? null : out;
}

async function sanitise(text) {
  const rules = await loadRules();
  return applyRules(text, rules);
}

module.exports = { sanitise, loadRules, applyRules, matchCase };
