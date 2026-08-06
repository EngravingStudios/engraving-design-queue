"use strict";
/*
 * Batch summary file — material breakdown (.txt) + packing sheets
 * (.pdf), bundled into a zip. Server-side generation triggered from
 * the per-batch-tab icon in public/index.html (alongside the split
 * icon).
 *
 * Deliberately a SEPARATE query from queue.js's fetchQueue(), which
 * excludes group_id=15 (fixings) from the design view — packing needs
 * every physical item going in the box, fixings included, so it can't
 * reuse that filtered query.
 */
const db = require("./db");
const { loadRules, applyRules } = require("./sanitise");

const MATERIAL_KEYWORDS = ["Brass", "Aluminium"];
const PACKING_TITLE_KEYWORDS = ["Garden", "Wall", "Plinth", "Mount"];
const PACKING_NOTE_KEYWORDS = ["Urgent", "Must go", "Brushed", "No paint", "No infill"];

function containsAny(text, keywords) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

async function fetchOrdersForSummary(statusValue) {
  const rules = await loadRules();
  const rows = await db.query(
    `SELECT o.id AS order_id, o.internal_notes, o.first_name, o.last_name,
            svc.name AS shipping_method, pr.file AS proof_file,
            i.id AS item_id, i.name AS item_name, i.qty,
            i.front_engraving, i.back_engraving,
            p.name AS product_name
       FROM orders o
       JOIN items  i ON i.order_id = o.id
  LEFT JOIN products p ON p.id = i.product_id
  LEFT JOIN ship_station_carrier_services svc ON svc.id = o.ship_station_service
  LEFT JOIN proofs pr ON pr.order_id = o.id AND pr.suppress = 0
      WHERE o.status = ?
   ORDER BY o.id ASC, i.id ASC`,
    [statusValue]
  );

  const byOrder = new Map();
  for (const r of rows) {
    if (!byOrder.has(r.order_id)) {
      byOrder.set(r.order_id, {
        id: r.order_id,
        customerName: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
        shippingMethod: r.shipping_method || null,
        // Same \r\n/\r -> \n normalisation applyRules() already does for
        // engraving text (§3) — internal_notes isn't run through that
        // engine (it's not engraving text), so without this a raw \r
        // survives into the PDF and pdfkit's WinAnsi font renders it as
        // a garbage "Ð" glyph instead of a line break.
        internalNotes: r.internal_notes
          ? r.internal_notes.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
          : null,
        proofFile: r.proof_file || null,
        lines: [],
      });
    }
    // No unmapped/product_id null special-casing needed here the way
    // queue.js has it — product_name || item_name already gives every
    // downstream check (material keywords, packing title keywords) the
    // raw customer-typed name as a fallback for unmapped items.
    byOrder.get(r.order_id).lines.push({
      productName: r.product_name || r.item_name,
      itemName: r.item_name,
      qty: Number(r.qty) || 1,
      front: applyRules(r.front_engraving, rules),
      back: applyRules(r.back_engraving, rules),
    });
  }
  return [...byOrder.values()];
}

/*
 * Every order goes into exactly ONE of these four lists — Mixed if a
 * title-level match for BOTH materials exists anywhere in the order,
 * Unknown if neither does. Not "any line that says Brass" style
 * per-line tagging: the ask was a shipping-prep list of ORDER numbers.
 */
function categoriseMaterials(orders) {
  const lists = { Brass: [], Aluminium: [], Mixed: [], Unknown: [] };
  for (const o of orders) {
    const hasBrass = o.lines.some((l) => containsAny(l.productName, ["Brass"]));
    const hasAluminium = o.lines.some((l) => containsAny(l.productName, ["Aluminium"]));
    if (hasBrass && hasAluminium) lists.Mixed.push(o.id);
    else if (hasBrass) lists.Brass.push(o.id);
    else if (hasAluminium) lists.Aluminium.push(o.id);
    else lists.Unknown.push(o.id);
  }
  return lists;
}

// new Date().toISOString() is always UTC — during British Summer Time
// (late Mar-late Oct) that reads an hour behind actual UK time.
// Europe/London (not a hardcoded +1) correctly handles the GMT/BST
// switch itself rather than needing manual adjustment twice a year.
function formatUkTimestamp(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

function buildMaterialListText(statusLabel, lists) {
  const section = (title, ids) =>
    `${title} (${ids.length})\n` +
    (ids.length ? ids.join("\n") : "(none)") +
    "\n";
  return (
    `${statusLabel} — material breakdown\nGenerated ${formatUkTimestamp(new Date())}\n\n` +
    [
      section("Brass", lists.Brass),
      section("Aluminium", lists.Aluminium),
      section("Mixed (Brass & Aluminium)", lists.Mixed),
      section("Unknown", lists.Unknown),
    ].join("\n")
  );
}

/*
 * OR, not AND — a title match alone is enough, a notes match alone is
 * enough. Checked independently per order, not per line, since a
 * packing sheet is a whole-order document.
 */
function ordersNeedingPackingSheet(orders) {
  return orders.filter((o) => {
    const titleMatch = o.lines.some((l) => containsAny(l.productName, PACKING_TITLE_KEYWORDS));
    const noteMatch = containsAny(o.internalNotes, PACKING_NOTE_KEYWORDS);
    return titleMatch || noteMatch;
  });
}

module.exports = {
  fetchOrdersForSummary,
  categoriseMaterials,
  buildMaterialListText,
  ordersNeedingPackingSheet,
};
