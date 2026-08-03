"use strict";
/*
 * Tick storage — deliberately NOT in the database.
 *
 * Ticks are working-state with a lifespan of a few days: useful while
 * a batch is live, worthless once the order has shipped. A flat JSON
 * file inside the app's own folder matches that lifespan far better
 * than a database column or an audit-comment trail — no schema
 * change, no history to maintain, and it self-cleans.
 *
 * Shape on disk: { "<itemId>": { designed_by, designed_at,
 *                                 verified_by, verified_at } }
 * Untick simply deletes the relevant two fields — no audit trail is
 * kept, by design (confirmed acceptable: value expires with the job).
 *
 * Held in memory for instant reads; writes are debounced and atomic
 * (write to a temp file, then rename) so concurrent ticks from several
 * tablets can never corrupt the file. A daily sweep drops any item
 * whose most recent tick is older than PRUNE_DAYS.
 */

const fs = require("fs");
const path = require("path");

const PRUNE_DAYS = 3;
const WRITE_DEBOUNCE_MS = 300;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let filePath = null;
let state = {};
let writeTimer = null;
let writing = false;

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  filePath = path.join(dataDir, "ticks.json");
  load();
  setInterval(prune, PRUNE_INTERVAL_MS).unref();
  prune(); // catch anything stale from before a restart
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
      console.error("[ticks] write failed:", err.message);
      writing = false;
      return;
    }
    fs.rename(tmp, filePath, (err2) => {
      writing = false;
      if (err2) console.error("[ticks] rename failed:", err2.message);
    });
  });
}

function get(itemId) {
  return state[String(itemId)] || {};
}

function set(itemId, kind, checked, user) {
  const key = String(itemId);
  const row = state[key] || {};
  if (checked) {
    row[kind + "_by"] = user;
    row[kind + "_at"] = new Date().toISOString();
  } else {
    delete row[kind + "_by"];
    delete row[kind + "_at"];
  }
  if (Object.keys(row).length === 0) delete state[key];
  else state[key] = row;
  scheduleWrite();
  return get(itemId);
}

function prune() {
  const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const [key, row] of Object.entries(state)) {
    const latest = Math.max(
      row.designed_at ? Date.parse(row.designed_at) : 0,
      row.verified_at ? Date.parse(row.verified_at) : 0
    );
    if (latest && latest < cutoff) {
      delete state[key];
      removed++;
    }
  }
  if (removed) {
    console.log(`[ticks] pruned ${removed} item(s) older than ${PRUNE_DAYS} days`);
    scheduleWrite();
  }
}

module.exports = { init, get, set };
