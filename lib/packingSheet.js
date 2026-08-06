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

function addOrderPage(doc, order, imageBuffer) {
  doc.addPage({ size: "A4", margin: 40 });

  doc.font("Helvetica-Bold").fontSize(18).fillColor("black")
    .text(`Order #${order.id}`);
  doc.moveDown(0.3);
  doc.font("Helvetica").fontSize(11)
    .text(`Customer: ${order.customerName || "(unknown)"}`)
    .text(`Shipping method: ${order.shippingMethod || "(unknown)"}`);

  if (order.internalNotes) {
    doc.moveDown(0.6);
    // Not "⚠" — pdfkit's built-in Helvetica is WinAnsi-encoded, not
    // full Unicode, and silently mangles it (renders as a stray "&").
    doc.font("Helvetica-Bold").fillColor("red")
      .text(`WARNING - Internal notes: ${order.internalNotes}`);
    doc.fillColor("black");
  }

  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(13).text("Items");
  doc.font("Helvetica").fontSize(11);
  order.lines.forEach((l) => {
    doc.moveDown(0.4);
    doc.font("Helvetica-Bold").text(`${l.itemName}  ×${l.qty}`);
    doc.font("Helvetica");
    if (l.front) doc.text(`Front: ${l.front}`);
    if (l.back) doc.text(`Back: ${l.back}`);
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
