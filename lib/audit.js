"use strict";
/*
 * Audit breadcrumb — separate from tick storage (lib/ticks.js).
 *
 * Purpose: a human-readable record on the order, so that if a wrong
 * product ever reaches a customer, opening the order's audit shows
 * who designed and who verified it, without needing the app open.
 *
 * This is deliberately ONE-WAY: a comment is written the moment a
 * tick goes off→on. Unticking writes nothing — no "unticked by"
 * comment, no correction trail. ticks.json (lib/ticks.js) remains the
 * single source of truth for CURRENT tick state and the live UI; this
 * module only ever adds a breadcrumb, it never reads state back and
 * is never consulted to decide what's ticked.
 *
 * Uses the existing `notes` table — no schema change.
 */

const db = require("./db");

const TABLE = "notes";
const ORDER_COL = "order_id";
const CONTENT_COL = "content";
const USER_COL = "user_id";
const AUDIT_USER_ID = 0; // matches the app's existing default for system-written rows

async function recordTick(orderId, itemId, kind, user) {
  const label = kind.toUpperCase(); // DESIGNED | VERIFIED
  const content = `Design Queue: item ${itemId} ${label} by ${user}`;
  try {
    await db.query(
      `INSERT INTO ${TABLE} (${ORDER_COL}, ${USER_COL}, ${CONTENT_COL}, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [orderId, AUDIT_USER_ID, content]
    );
  } catch (e) {
    // Audit failure must never block the tick itself — the live UI
    // and ticks.json have already updated by the time this runs.
    console.error("[audit] failed to write comment:", e.message);
  }
}

module.exports = { recordTick };
