"use strict";
/*
 * Batch A/B split — file-backed, same rationale as ticks.js (§7): this
 * is short-lived working state for dividing a live batch's design work
 * across two designers, not something that belongs in the fulfilment
 * schema.
 *
 * Keyed by status value -> { [productGroupName]: "A"|"B" }, where
 * "product group" is the exact same grouping key the queue already
 * renders by (an order's first line's product name — see queue.js's
 * computeGroupTotals()). A group, once assigned, is LOCKED: it's only
 * ever set the first time that name is seen for that status, never
 * reassigned by a later recompute — confirmed explicitly, since staff
 * work through EngraveLab in this order and a group flipping buckets
 * mid-batch would be actively confusing.
 */

const fs = require("fs");
const path = require("path");

const WRITE_DEBOUNCE_MS = 300;

let filePath = null;
let state = {}; // { [status]: { [groupName]: "A"|"B" } }
let writeTimer = null;
let writing = false;

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  filePath = path.join(dataDir, "batch-splits.json");
  load();
}

function load() {
  try {
    state = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    state = {}; // missing file on first run is normal, not an error
  }
}

function scheduleWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, WRITE_DEBOUNCE_MS);
}

function flush() {
  if (writing) return scheduleWrite(); // retry after the in-flight write
  writing = true;
  const tmp = filePath + ".tmp";
  fs.writeFile(tmp, JSON.stringify(state), (err) => {
    if (err) {
      console.error("[batch-splits] write failed:", err.message);
      writing = false;
      return;
    }
    fs.rename(tmp, filePath, (err2) => {
      writing = false;
      if (err2) console.error("[batch-splits] rename failed:", err2.message);
    });
  });
}

/*
 * A status value like print_1st_batch gets reused for a brand new set
 * of orders once the old batch is fully moved out — clearForStatus()
 * (called from queue.moveBatch() on success) is the normal way that
 * gets cleaned up. This is the belt-and-braces fallback for anything
 * that slips past that (crash, manual DB edit, etc): if NONE of a
 * status's locked group names are present in the current queue at
 * all, the stored split can only be a leftover from a previous cycle
 * — discard it. A batch that's simply had some orders move through it
 * during the day still has plenty of overlap, so this never fires on
 * ordinary same-day activity.
 */
function pruneIfStale(status, currentNames) {
  const groups = state[status];
  if (!groups || Object.keys(groups).length === 0) return;
  const names = new Set(currentNames);
  const stillPresent = Object.keys(groups).some((n) => names.has(n));
  if (!stillPresent) {
    delete state[status];
    scheduleWrite();
  }
}

/* Read-only view of the current lock map for a status ({} if none). */
function getGroups(status) {
  return state[status] || {};
}

function isActive(status) {
  return !!(state[status] && Object.keys(state[status]).length > 0);
}

/*
 * Lazily assign any of `groupTotals` ([{name, qty}]) not already
 * locked, into whichever bucket currently has the smaller LIVE total
 * (computed fresh from groupTotals every call, so it reflects today's
 * actual quantities). No-op if this status isn't split. Called on
 * every queue fetch — this is what makes "a new order lands in an
 * already-split batch" require no manual action.
 */
function fillNew(status, groupTotals) {
  const groups = state[status];
  if (!groups) return;
  const totals = { A: 0, B: 0 };
  for (const { name, qty } of groupTotals) {
    const bucket = groups[name];
    if (bucket) totals[bucket] += qty;
  }
  let changed = false;
  for (const { name, qty } of groupTotals) {
    if (groups[name]) continue;
    const bucket = totals.A <= totals.B ? "A" : "B";
    groups[name] = bucket;
    totals[bucket] += qty;
    changed = true;
  }
  if (changed) scheduleWrite();
}

/*
 * Explicit "Split A/B" action. If a valid (non-stale) split is already
 * active for this status, this is a no-op — locks are permanent,
 * re-clicking never reshuffles. Otherwise computes a fresh greedy
 * balance over every group present right now: largest group first,
 * each one dropped into whichever bucket is currently smaller (the
 * standard "longest processing time" bin-balancing heuristic — not a
 * guaranteed even split, but close for any realistic mix of group
 * sizes). Returns true if it actually started a new split.
 */
function start(status, groupTotals) {
  pruneIfStale(status, groupTotals.map((g) => g.name));
  if (isActive(status)) return false;
  const sorted = [...groupTotals].sort((a, b) => b.qty - a.qty);
  const groups = {};
  const totals = { A: 0, B: 0 };
  for (const { name, qty } of sorted) {
    const bucket = totals.A <= totals.B ? "A" : "B";
    groups[name] = bucket;
    totals[bucket] += qty;
  }
  state[status] = groups;
  scheduleWrite();
  return true;
}

/* Called after a batch is successfully moved out (§8) — that status's
   order set is about to be entirely replaced by tomorrow's, so any
   split for it is done with. */
function clearForStatus(status) {
  if (state[status]) {
    delete state[status];
    scheduleWrite();
  }
}

module.exports = {
  init,
  getGroups,
  isActive,
  fillNew,
  start,
  pruneIfStale,
  clearForStatus,
};
