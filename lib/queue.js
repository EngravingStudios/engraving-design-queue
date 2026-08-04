"use strict";
const db = require("./db");
const { loadRules, applyRules } = require("./sanitise");
const helpscout = require("./helpscout");
const ticks = require("./ticks");
const colours = require("./colours");
const audit = require("./audit");

let cfg = null;
function init(appConfig) {
  cfg = appConfig;
}

/*
 * Fetch every order in a given status with its items, joined to
 * products. The fulfilment database is READ-ONLY from this app's
 * point of view — no schema changes, no writes to orders/items/
 * products/sanitise. Tick state and colour overrides come from local
 * files (lib/ticks.js, lib/colours.js), merged in after the query.
 */
async function fetchQueue(statusValue) {
  const rules = await loadRules();

  const rows = await db.query(
    `SELECT o.id AS order_id, o.internal_notes,
            i.id AS item_id, i.product_id, i.name AS item_name, i.qty,
            i.front_engraving, i.back_engraving,
            p.name AS product_name, p.group_id
       FROM orders o
       JOIN items  i ON i.order_id = o.id
  LEFT JOIN products p ON p.id = i.product_id
      WHERE o.status = ?
   ORDER BY o.id ASC, i.id ASC`,
    [statusValue]
  );

  const excluded = new Set((cfg.excludedGroupIds || []).map(Number));
  const byOrder = new Map();
  const unmappedNames = new Set();

  for (const r of rows) {
    if (!byOrder.has(r.order_id))
      byOrder.set(r.order_id, {
        id: r.order_id,
        internalNotes: r.internal_notes || null,
        lines: [],
        hiddenCount: 0,
      });
    const order = byOrder.get(r.order_id);

    const isMapped = r.product_name != null;
    const isExcluded = isMapped && excluded.has(Number(r.group_id));
    if (isExcluded) {
      order.hiddenCount += 1;
      continue;
    }
    if (!isMapped) unmappedNames.add((r.item_name || "").trim());

    const tick = ticks.get(r.item_id);

    order.lines.push({
      itemId: r.item_id,
      productId: r.product_id,
      productName: isMapped ? r.product_name : "Unmapped",
      rawName: r.item_name,
      colour: isMapped ? colours.get(r.product_id) : null, // null → app auto-hashes
      qty: Number(r.qty) || 1,
      front: applyRules(r.front_engraving, rules),
      back: applyRules(r.back_engraving, rules),
      unmapped: !isMapped,
      designedBy: tick.designed_by || null,
      designedAt: tick.designed_at || null,
      verifiedBy: tick.verified_by || null,
      verifiedAt: tick.verified_at || null,
    });
  }

  const orders = [...byOrder.values()].filter((o) => o.lines.length > 0);

  // fire-and-forget: report never-before-seen unmapped names (in-memory dedup only)
  if (unmappedNames.size > 0) {
    reportUnmapped([...unmappedNames]).catch((e) =>
      console.error("[unmapped-report]", e.message)
    );
  }

  return orders;
}

/* Order counts per status for the tab badges. Read-only. */
async function statusCounts() {
  const values = [
    ...cfg.statuses.batches.map((b) => b.value),
    cfg.statuses.target.value,
  ];
  const placeholders = values.map(() => "?").join(",");
  const rows = await db.query(
    `SELECT status, COUNT(*) AS n FROM orders
      WHERE status IN (${placeholders}) GROUP BY status`,
    values
  );
  const counts = Object.fromEntries(values.map((v) => [v, 0]));
  for (const r of rows) counts[r.status] = Number(r.n);
  return counts;
}

/*
 * Unmapped-name reporting, deduped for the lifetime of the process
 * only (a plain in-memory Set — no table). Worst case after a
 * restart is one repeat ticket for a name that's still unmapped;
 * that's an acceptable trade for not adding a table.
 */
const reportedUnmapped = new Set();
async function reportUnmapped(names) {
  const fresh = names.filter((n) => n && !reportedUnmapped.has(n));
  if (!fresh.length) return;
  fresh.forEach((n) => reportedUnmapped.add(n));
  const ticketId = await helpscout.createUnmappedTicket(fresh);
  console.log(
    `[unmapped-report] ticket ${ticketId} raised for: ${fresh.join(" | ")}`
  );
}

/*
 * Tick / untick designed or verified on an item — file-backed (see
 * lib/ticks.js), not the database. Returns immediately from the
 * in-memory update, same as before — the audit comment (below) is
 * fired off in the background and never delays the tick response or
 * the Socket.IO broadcast to other screens.
 */
function setTick(itemId, kind, checked, user) {
  if (!["designed", "verified"].includes(kind))
    throw new Error("bad tick kind");
  const before = ticks.get(itemId);
  const wasOn = !!before[kind + "_at"];
  const state = ticks.set(itemId, kind, checked, user);

  // fire-and-forget: on an OFF→ON transition only, write a one-way
  // audit comment on the order — once per order per kind (an order
  // has exactly one designer and one verifier), on whichever line is
  // first ticked, not once per line. Unticking writes nothing
  // (intentional — no correction trail). Runs AFTER the tick has
  // already been applied and returned, so it never adds latency to
  // the live update other screens see.
  if (checked && !wasOn) {
    orderIdForItem(itemId)
      .then(async (orderId) => {
        if (orderId == null) return;
        const siblingIds = (await itemIdsForOrder(orderId)).filter((id) => id !== itemId);
        const alreadyRecorded = siblingIds.some((id) => !!ticks.get(id)[kind + "_at"]);
        if (!alreadyRecorded) return audit.recordTick(orderId, kind, user);
      })
      .catch((e) => console.error("[audit] lookup failed:", e.message));
  }
  return state;
}

/* Small lookup so the audit comment can be attached to the right
   order — ticks.json only knows the item id, not its order. */
async function orderIdForItem(itemId) {
  const rows = await db.query(`SELECT order_id FROM items WHERE id = ?`, [itemId]);
  return rows[0] ? rows[0].order_id : null;
}

/* All item ids belonging to an order — lets setTick() check whether a
   sibling line already carries this tick kind before writing the
   audit comment (one comment per order, not per line). */
async function itemIdsForOrder(orderId) {
  const rows = await db.query(`SELECT id FROM items WHERE order_id = ?`, [orderId]);
  return rows.map((r) => r.id);
}

/*
 * Move an entire batch to the target status inside one transaction.
 * This is the one write this app makes to the fulfilment database —
 * advancing orders.status is the actual job, not incidental state.
 * The empty-target check happens HERE, at move time, with a lock —
 * a client's ten-second-old view of the target is never trusted.
 */
async function moveBatch(fromStatus, force, user) {
  const target = cfg.statuses.target.value;
  const conn = await db.get().getConnection();
  let movedIds = [];
  try {
    await conn.beginTransaction();
    const [[{ n }]] = await conn.query(
      `SELECT COUNT(*) AS n FROM orders WHERE status = ? FOR UPDATE`,
      [target]
    );
    if (Number(n) > 0 && !force) {
      await conn.rollback();
      return { moved: 0, conflict: Number(n) };
    }
    // Locked and captured here, not re-derived from the UPDATE's
    // affected-row count, so the audit breadcrumb below (§7a-style,
    // one line per order) knows exactly which orders moved.
    const [moving] = await conn.query(
      `SELECT id FROM orders WHERE status = ? FOR UPDATE`,
      [fromStatus]
    );
    movedIds = moving.map((r) => r.id);
    const [result] = await conn.query(
      `UPDATE orders SET status = ? WHERE status = ?`,
      [target, fromStatus]
    );
    await conn.commit();
    // Fire after commit, one breadcrumb per order — moves are
    // infrequent (§8) so this isn't a latency-sensitive path.
    await Promise.all(
      movedIds.map((id) => audit.recordMove(id, cfg.statuses.target.label, user))
    );
    return { moved: result.affectedRows, conflict: 0 };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

/*
 * Raise an issue: HelpScout ticket first, then status change.
 * If the ticket fails the order stays put — never silently parked in
 * Pending with no ticket behind it.
 */
async function raiseIssue(orderId, notes, user) {
  const lines = await db.query(
    `SELECT i.qty, i.front_engraving AS front, i.back_engraving AS back,
            COALESCE(p.name, i.name) AS productName
       FROM items i LEFT JOIN products p ON p.id = i.product_id
      WHERE i.order_id = ?`,
    [orderId]
  );
  const ticketId = await helpscout.createIssueTicket({
    orderId,
    notes,
    user,
    lines,
    orderUrl: (cfg.fulfilmentOrderUrl || "") + orderId,
  });
  await db.query(`UPDATE orders SET status = ? WHERE id = ?`, [
    cfg.statuses.issue.value,
    orderId,
  ]);
  await audit.recordIssue(orderId, notes, user);
  return ticketId;
}

module.exports = {
  init,
  fetchQueue,
  statusCounts,
  setTick,
  moveBatch,
  raiseIssue,
};
