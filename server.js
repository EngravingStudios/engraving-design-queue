"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const session = require("express-session");
const FileStore = require("session-file-store")(session);
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const db = require("./lib/db");
const queue = require("./lib/queue");
const helpscout = require("./lib/helpscout");
const ticks = require("./lib/ticks");
const colours = require("./lib/colours");
const batchSplits = require("./lib/batchSplits");

const config = require("./lib/config").load(
  path.join(__dirname, "config.json")
);
const BASE = config.basePath || "/design";
const DATA_DIR = path.join(__dirname, "data");

db.init(config.db);
queue.init(config);
helpscout.init(config.helpscout);
ticks.init(DATA_DIR);        // file-backed tick state — see lib/ticks.js
colours.init(DATA_DIR);      // optional colour overrides — see lib/colours.js
batchSplits.init(DATA_DIR);  // file-backed A/B split state — see lib/batchSplits.js

const app = express();
app.set("trust proxy", 1); // behind Nginx
app.use(express.json());

const sessionMiddleware = session({
  // Default express-session store is in-memory — wiped on every
  // restart (deploys, crashes, reboots), silently logging out every
  // tablet regardless of the 30-day cookie below. File-backed so
  // sessions actually survive routine restarts.
  store: new FileStore({ path: path.join(DATA_DIR, "sessions"), logFn: () => {} }),
  name: "design.sid",
  secret: config.auth.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    path: BASE,
    httpOnly: true,
    sameSite: "lax",
    secure: "auto",
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days — tablets stay logged in
  },
});
app.use(sessionMiddleware);

const router = express.Router();
app.use(BASE, router);

/* ── Auth ─────────────────────────────────────────────── */
function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith("/api"))
    return res.status(401).json({ error: "unauthorised" });
  return res.redirect(BASE + "/login");
}

router.get("/login", (req, res) => {
  if (req.session.authed) return res.redirect(BASE + "/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const ok =
    username === config.auth.username &&
    (await bcrypt.compare(password || "", config.auth.passwordHash));
  if (!ok) return res.status(401).json({ error: "Wrong username or password" });
  req.session.authed = true;
  res.json({ ok: true });
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* ── App + API ────────────────────────────────────────── */
router.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

router.get("/api/config", requireAuth, (req, res) => {
  res.json({
    statuses: config.statuses,
    staff: config.staff,
    fulfilmentOrderUrl: config.fulfilmentOrderUrl,
  });
});

router.get("/api/queue", requireAuth, async (req, res) => {
  try {
    const status = String(req.query.status || "");
    const valid = [
      ...config.statuses.batches.map((b) => b.value),
      config.statuses.target.value,
    ];
    if (!valid.includes(status))
      return res.status(400).json({ error: "unknown status" });
    const [orders, counts] = await Promise.all([
      queue.fetchQueue(status),
      queue.statusCounts(),
    ]);
    // fetchQueue() may have just lazily locked in a new group's split
    // bucket (see queue.js/batchSplits.js) — check AFTER, not before.
    res.json({ status, orders, counts, splitActive: queue.isSplitActive(status) });
  } catch (e) {
    console.error("[api/queue]", e);
    res.status(500).json({ error: "queue fetch failed" });
  }
});

/* ── HTTP + Socket.IO ─────────────────────────────────── */
const server = http.createServer(app);
const io = new Server(server, { path: BASE + "/socket.io" });

// share the session with socket handshakes; refuse unauthenticated sockets
io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const sess = socket.request.session;
  if (sess && sess.authed) return next();
  next(new Error("unauthorised"));
});

io.on("connection", (socket) => {
  /* Tick / untick. Persist, then broadcast to every screen. */
  socket.on("tick", async (payload, cb) => {
    try {
      const { itemId, kind, checked, user } = payload || {};
      if (!config.staff.includes(user))
        return cb && cb({ error: "unknown user" });
      const state = queue.setTick(Number(itemId), kind, !!checked, user);
      io.emit("tick", { itemId: Number(itemId), state });
      cb && cb({ ok: true, state });
    } catch (e) {
      console.error("[tick]", e);
      cb && cb({ error: "tick failed" });
    }
  });

  /* Move a batch to Label Hold. Server-side empty check is authoritative. */
  socket.on("move_batch", async (payload, cb) => {
    try {
      const { fromStatus, force, user } = payload || {};
      const validFrom = config.statuses.batches.map((b) => b.value);
      if (!validFrom.includes(fromStatus))
        return cb && cb({ error: "unknown batch" });
      if (!config.staff.includes(user))
        return cb && cb({ error: "unknown user" });
      const result = await queue.moveBatch(fromStatus, !!force, user);
      if (result.conflict && !force) return cb && cb(result);
      io.emit("orders_changed", { reason: "move", fromStatus });
      cb && cb(result);
    } catch (e) {
      console.error("[move_batch]", e);
      cb && cb({ error: "move failed" });
    }
  });

  /* Raise an issue: ticket first, then status → pending, then broadcast. */
  socket.on("report_issue", async (payload, cb) => {
    try {
      const { orderId, notes, user } = payload || {};
      if (!notes || !String(notes).trim())
        return cb && cb({ error: "notes required" });
      if (!config.staff.includes(user))
        return cb && cb({ error: "unknown user" });
      const ticketId = await queue.raiseIssue(
        Number(orderId),
        String(notes).trim(),
        user
      );
      io.emit("orders_changed", { reason: "issue", orderId: Number(orderId) });
      cb && cb({ ok: true, ticketId });
    } catch (e) {
      console.error("[report_issue]", e);
      cb && cb({ error: "Could not create the ticket — order NOT moved. Try again or raise it manually." });
    }
  });

  /* Split a batch A/B (lib/batchSplits.js). No-op if a valid split is
     already active for this status — locks are permanent once set. */
  socket.on("split_batch", async (payload, cb) => {
    try {
      const { status, user } = payload || {};
      const validFrom = config.statuses.batches.map((b) => b.value);
      if (!validFrom.includes(status))
        return cb && cb({ error: "unknown batch" });
      if (!config.staff.includes(user))
        return cb && cb({ error: "unknown user" });
      const result = await queue.splitBatch(status);
      io.emit("orders_changed", { reason: "split", status });
      cb && cb({ ok: true, ...result });
    } catch (e) {
      console.error("[split_batch]", e);
      cb && cb({ error: "split failed" });
    }
  });
});

/* static assets (login page css etc.) — after routes so / stays gated */
router.use(express.static(path.join(__dirname, "public"), { index: false }));

server.listen(config.port, "127.0.0.1", () => {
  console.log(
    `Design Queue listening on 127.0.0.1:${config.port} under ${BASE}`
  );
});
