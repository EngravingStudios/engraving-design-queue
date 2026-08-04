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

async function writeNote(orderId, content) {
  try {
    await db.query(
      `INSERT INTO ${TABLE} (${ORDER_COL}, ${USER_COL}, ${CONTENT_COL}, created_at, updated_at)
       VALUES (?, ?, ?, NOW(), NOW())`,
      [orderId, AUDIT_USER_ID, content]
    );
  } catch (e) {
    // Audit failure must never block the action it's recording — by
    // the time this runs, the tick/issue itself has already gone
    // through.
    console.error("[audit] failed to write note:", e.message);
  }
}

async function recordTick(orderId, kind, user) {
  const label = kind.toUpperCase(); // DESIGNED | VERIFIED
  await writeNote(orderId, `Design Queue: Order #${orderId} ${label} by ${user}`);
}

/* Breadcrumb for issues raised from the Design Queue — same reasoning
   as recordTick (§7a): a human-readable trail on the order itself,
   visible without the app open. */
async function recordIssue(orderId, notes, user) {
  await writeNote(
    orderId,
    `Design Queue: ${user} raised an issue at the design stage — "${notes}"`
  );
}

/* Breadcrumb per order when a batch moves to Label Hold — same
   reasoning as recordTick/recordIssue: one line per order, written
   after the move has already committed, visible without the app
   open. */
async function recordMove(orderId, targetLabel, user) {
  await writeNote(
    orderId,
    `Design Queue: Order #${orderId} moved to ${targetLabel} by ${user}`
  );
}

module.exports = { recordTick, recordIssue, recordMove };
