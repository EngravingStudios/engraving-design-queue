"use strict";
/*
 * Optional colour overrides, keyed by product_id. Starts empty — the
 * automatic full-hue-wheel hash (see public/index.html: typeColour)
 * already gives every product a permanent, distinct colour with zero
 * setup. This file exists only for the day you want to hand-pick one.
 *
 * Lives inside the app's own folder (data/product-colours.json), same
 * pattern as ticks.js. Hot-reloaded on a short cache so an edit takes
 * effect without a restart.
 */

const fs = require("fs");
const path = require("path");

const CACHE_MS = 60 * 1000;
let filePath = null;
let cache = { data: {}, loadedAt: 0 };

function init(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  filePath = path.join(dataDir, "product-colours.json");
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "{}\n");
}

function get(productId) {
  const now = Date.now();
  if (now - cache.loadedAt > CACHE_MS) {
    try {
      cache = { data: JSON.parse(fs.readFileSync(filePath, "utf8")), loadedAt: now };
    } catch (e) {
      console.error("[colours] failed to read override file:", e.message);
    }
  }
  return cache.data[String(productId)] || null;
}

module.exports = { init, get };
