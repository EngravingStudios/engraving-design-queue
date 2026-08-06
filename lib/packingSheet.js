"use strict";
/*
 * One A4 page per order needing a packing sheet (lib/summary.js
 * decides which orders qualify). Proof images are fetched server-side
 * from the fulfilment app's own upload path — a network call, not a
 * DB read, since proofs.file is just a filename that lives under a
 * fixed public URL there. A missing/failed fetch omits the image
 * rather than failing the whole batch's zip — one order's absent
 * proof shouldn't block everyone else's packing sheets.
 */
const PDFDocument = require("pdfkit");

let proofBaseUrl = null;
function init(appConfig) {
  proofBaseUrl = appConfig.proofImageBaseUrl;
}

async function fetchProofImage(filename) {
  if (!filename || !proofBaseUrl) return null;
  try {
    const res = await fetch(proofBaseUrl + encodeURIComponent(filename));
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.error("[packing-sheet] proof image fetch failed:", filename, e.message);
    return null;
  }
}

/* Bold label + regular value on the same line — pdfkit has no inline
   rich-text markup, so this is the standard pattern: {continued:true}
   keeps the cursor on the same line for the next .text() call. */
function field(doc, label, value) {
  doc.font("Helvetica-Bold").text(`${label} `, { continued: true });
  doc.font("Helvetica").text(value);
}

function hRule(doc) {
  const y = doc.y;
  doc.moveTo(doc.page.margins.left, y)
    .lineTo(doc.page.width - doc.page.margins.right, y)
    .lineWidth(0.75)
    .strokeColor("#999999")
    .stroke();
  doc.moveDown(0.4);
}

function addOrderPage(doc, order, imageBuffer) {
  doc.addPage({ size: "A4", margin: 40 });
  doc.fillColor("black");

  doc.font("Helvetica-Bold").fontSize(18).text(`Order ${order.id}`);
  doc.moveDown(0.3);
  doc.fontSize(11);
  field(doc, "Customer:", order.customerName || "(unknown)");
  field(doc, "Shipping method:", order.shippingMethod || "(unknown)");

  if (order.internalNotes) {
    doc.moveDown(0.6);
    // Bold black bordered box, not the earlier red text — this is
    // routine shop-floor guidance ("give to Andy to send"), not an
    // error state, so it needs to stand out without reading as alarm.
    // Box height is measured from the actual text first (heightOfString)
    // so the border fits the note's real length, not a guessed size.
    const boxPad = 8;
    const boxWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const textWidth = boxWidth - boxPad * 2;
    doc.font("Helvetica-Bold").fontSize(11);
    const textHeight = doc.heightOfString(order.internalNotes, { width: textWidth, align: "center" });
    const boxX = doc.page.margins.left;
    const boxY = doc.y;
    // Equal top/bottom padding (boxPad both sides) centres it
    // vertically; align:"center" below centres it horizontally.
    const boxHeight = textHeight + boxPad * 2;
    doc.lineWidth(2).strokeColor("black")
      .rect(boxX, boxY, boxWidth, boxHeight).stroke();
    doc.text(order.internalNotes, boxX + boxPad, boxY + boxPad, { width: textWidth, align: "center" });
    doc.y = boxY + boxHeight + 10;
  }

  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(13).text("Items");
  doc.fontSize(11);
  order.lines.forEach((l) => {
    doc.moveDown(0.5);
    hRule(doc);
    doc.font("Helvetica-Bold").text(`${l.itemName}  ×${l.qty}`);
    if (l.front) field(doc, "Front:", l.front);
    if (l.back) field(doc, "Back:", l.back);
  });

  if (imageBuffer) {
    doc.moveDown(1);
    try {
      doc.image(imageBuffer, { fit: [420, 420], align: "center" });
    } catch (e) {
      // A corrupt/unexpected-format download shouldn't take the whole
      // page down — same "omit, don't fail" reasoning as a missing file.
      console.error("[packing-sheet] failed to embed proof image, order", order.id, e.message);
    }
  }
}

/* Builds sequentially, not in parallel (Promise.all) — pdfkit's
   synchronous drawing calls aren't safe to interleave from concurrent
   awaits, so each order's image must be fetched and drawn before
   moving to the next. Returns the PDFDocument itself (a Readable
   stream) for the caller to pipe/append directly — no temp file. */
async function generatePackingSheetsPdf(orders) {
  const doc = new PDFDocument({ autoFirstPage: false });
  for (const order of orders) {
    const imageBuffer = await fetchProofImage(order.proofFile);
    addOrderPage(doc, order, imageBuffer);
  }
  doc.end();
  return doc;
}

module.exports = { init, generatePackingSheetsPdf };
