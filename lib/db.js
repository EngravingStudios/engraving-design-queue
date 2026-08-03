"use strict";
const mysql = require("mysql2/promise");

let pool = null;

function init(cfg) {
  pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port || 3306,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: cfg.connectionLimit || 10,
    charset: "utf8mb4",
    dateStrings: true,
    /* DigitalOcean managed MySQL requires TLS. Set db.ssl: true in
       config; optionally db.caFile for full certificate verification
       (download ca-certificate.crt from the DO database dashboard). */
    ssl: cfg.ssl
      ? cfg.caFile
        ? { ca: require("fs").readFileSync(cfg.caFile) }
        : { rejectUnauthorized: false }
      : undefined,
  });
  return pool;
}

function get() {
  if (!pool) throw new Error("DB pool not initialised");
  return pool;
}

async function query(sql, params) {
  const [rows] = await get().execute(sql, params);
  return rows;
}

module.exports = { init, get, query };
