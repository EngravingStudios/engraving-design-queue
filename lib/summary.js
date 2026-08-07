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
const PAINT_COLOUR_WORDS = [
  "red", "blue", "green", "yellow", "black", "white", "silver", "gold",
  "bronze", "orange", "purple", "pink", "grey", "gray", "brown", "cream",
  "ivory", "navy", "maroon", "teal", "turquoise", "beige",
];
// RAL/BS paint reference codes (e.g. "RAL 6037", "BS4800 04 D 45",
// "bs381c-166") — real spec numbers, not plain English colour names, so
// a fixed word list can't catch these; a pattern can. \b before RAL/BS
// stops it matching inside an unrelated word (e.g. "ABS"), requiring a
// digit right after stops a bare "bs"/"ral" substring match with no
// actual code attached.
const PAINT_COLOUR_CODE_PATTERN = /\b(ral|bs)\s*\d/i;

function containsAny(text, keywords) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/* Catches phrases like "red paint" or "roundel blue paint" without
   pinning down word order/spacing — real customer/staff phrasing
   varies too much for an exact-phrase list (unlike PACKING_NOTE_KEYWORDS
   above). A colour word anywhere in the same field as "paint" is enough;
   over-flagging a borderline note is a much smaller cost than missing a
   real paint instruction. Also catches RAL/BS colour codes alongside
   "paint" (e.g. "RAL 6037 FOR PAINT") the same way — a code is just
   another way of naming a colour, not a different signal. */
function containsColourPaintPhrase(text) {
  if (!text) return false;
  const lower = String(text).toLowerCase();
  if (!lower.includes("paint")) return false;
  return PAINT_COLOUR_WORDS.some((c) => lower.includes(c)) || PAINT_COLOUR_CODE_PATTERN.test(text);
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

// Thin-grade brass ("1mm Brass") and anything noted for a separate wash
// pass don't get processed with the main batch — these need a human to
// look at them, so they're routed to Unknown (repurposed here as "needs
// manual handling", not just "couldn't tell the material") regardless of
// what material the order would otherwise categorise as. Checked BEFORE
// the normal Brass/Aluminium/Mixed logic below so they always win, even
// on an order that would otherwise be a clean Brass or Mixed match.
const THIN_BRASS_KEYWORD = "1mm Brass";
const MANUAL_HANDLING_NOTE_KEYWORDS = ["Put through wash"];

function needsManualMaterialHandling(order) {
  const thinBrass =
    order.lines.some(
      (l) => containsAny(l.productName, [THIN_BRASS_KEYWORD]) || containsAny(l.back, [THIN_BRASS_KEYWORD])
    ) || containsAny(order.internalNotes, [THIN_BRASS_KEYWORD]);
  const washNote =
    order.lines.some((l) => containsAny(l.back, MANUAL_HANDLING_NOTE_KEYWORDS)) ||
    containsAny(order.internalNotes, MANUAL_HANDLING_NOTE_KEYWORDS);
  return thinBrass || washNote;
}

/*
 * Every order goes into exactly ONE of these four lists — Mixed if a
 * title-level match for BOTH materials exists anywhere in the order,
 * Unknown if neither does (or if it needs manual handling regardless of
 * material, see needsManualMaterialHandling above). Not "any line that
 * says Brass" style per-line tagging: the ask was a shipping-prep list
 * of ORDER numbers.
 */
function categoriseMaterials(orders) {
  const lists = { Brass: [], Aluminium: [], Mixed: [], Unknown: [] };
  for (const o of orders) {
    if (needsManualMaterialHandling(o)) {
      lists.Unknown.push(o.id);
      continue;
    }
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
 * OR, not AND — a title match alone is enough, a keyword match in EITHER
 * internal_notes or any line's back engraving is enough. Checked
 * independently per order (title) or across all lines (keyword), not
 * gated on a single field, since a packing sheet is a whole-order
 * document and the same keywords (Urgent/Must go/Brushed/etc.) can show
 * up as office-entered notes or as customer-typed back-plate text.
 */
function ordersNeedingPackingSheet(orders) {
  return orders.filter((o) => {
    const titleMatch = o.lines.some((l) => containsAny(l.productName, PACKING_TITLE_KEYWORDS));
    const keywordMatch =
      containsAny(o.internalNotes, PACKING_NOTE_KEYWORDS) ||
      o.lines.some((l) => containsAny(l.back, PACKING_NOTE_KEYWORDS));
    const colourPaintMatch =
      containsColourPaintPhrase(o.internalNotes) ||
      o.lines.some((l) => containsColourPaintPhrase(l.back));
    return titleMatch || keywordMatch || colourPaintMatch;
  });
}

module.exports = {
  fetchOrdersForSummary,
  categoriseMaterials,
  buildMaterialListText,
  ordersNeedingPackingSheet,
};
