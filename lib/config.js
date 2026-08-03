"use strict";
/*
 * Config loader with central-store references.
 *
 * config.json may set "sharedConfigFile" to the path of the existing
 * central config on the droplet. Any string value anywhere in the
 * config of the form:
 *
 *      "@shared:helpscout.client_id"
 *
 * is resolved from that file at startup. Rotate a key in the central
 * file, restart the app, done — nothing secret is duplicated here.
 *
 * The shared file may be:
 *   - JSON  → dot-path lookup ("helpscout.client_id")
 *   - .env-style KEY=VALUE lines → key lookup ("HELPSCOUT_CLIENT_ID")
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function parseShared(filePath) {
  /* PHP config (e.g. /etc/orders-app/config.php returning an array):
     let PHP itself parse it and hand us JSON — no fragile regex. */
  if (filePath.endsWith(".php")) {
    const json = execFileSync(
      "php",
      ["-r", "echo json_encode(require $argv[1]);", filePath],
      { encoding: "utf8", timeout: 5000 }
    );
    return { type: "json", data: JSON.parse(json) };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return { type: "json", data: JSON.parse(raw) };

  // KEY=VALUE (.env style); ignores comments and blank lines
  const data = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    data[m[1]] = v;
  }
  return { type: "env", data };
}

function lookup(shared, ref) {
  if (shared.type === "env") {
    if (!(ref in shared.data))
      throw new Error(`Shared config has no key "${ref}"`);
    return shared.data[ref];
  }
  let cur = shared.data;
  for (const part of ref.split(".")) {
    if (cur == null || typeof cur !== "object" || !(part in cur))
      throw new Error(`Shared config has no key "${ref}" (failed at "${part}")`);
    cur = cur[part];
  }
  return cur;
}

function resolve(node, shared, trail) {
  if (typeof node === "string" && node.startsWith("@shared:")) {
    if (!shared)
      throw new Error(
        `"${trail}" references the shared config but "sharedConfigFile" is not set`
      );
    return lookup(shared, node.slice("@shared:".length).trim());
  }
  if (Array.isArray(node))
    return node.map((v, i) => resolve(v, shared, `${trail}[${i}]`));
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node))
      out[k] = resolve(v, shared, trail ? `${trail}.${k}` : k);
    return out;
  }
  return node;
}

function load(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  let shared = null;
  if (cfg.sharedConfigFile) {
    const p = path.resolve(path.dirname(configPath), cfg.sharedConfigFile);
    shared = parseShared(p);
  }
  return resolve(cfg, shared, "");
}

module.exports = { load };
