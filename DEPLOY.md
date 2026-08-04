# ES Design Queue — Deployment Guide

Everything below runs on the existing `automation` droplet. Nothing here
modifies existing rows — all database changes are additive.

---

## 1. Database changes

**None.** The fulfilment database schema is completely untouched — no
new columns, no new tables. The app only ever runs SELECT against
`orders`, `items`, `products` and `sanitise`, plus one UPDATE to the
`orders.status` column when a batch is moved or an issue is raised —
that's the app doing its actual job (advancing an order through your
existing workflow), not a schema change.

Design/verify tick state and any colour overrides live in small JSON
files inside the app's own folder (`data/ticks.json`,
`data/product-colours.json`) — see §2 below. Ticks intentionally have
no audit trail and expire automatically after 3 days, since a tick
only has value while the job is still in production.

### Dedicated database user (least privilege)
Pure read access, plus the one UPDATE the app is actually for. This
user cannot read customer names/addresses/phones/emails and cannot
delete anything, anywhere. Your database is DigitalOcean managed
MySQL, so the user host is `%`, not `localhost`.

```sql
CREATE USER 'design_app'@'%' IDENTIFIED BY 'CHOOSE_A_STRONG_PASSWORD';

GRANT SELECT (id, status, internal_notes) ON fulfilment.orders   TO 'design_app'@'%';
GRANT UPDATE (status)                     ON fulfilment.orders   TO 'design_app'@'%';
GRANT SELECT                              ON fulfilment.items    TO 'design_app'@'%';
GRANT SELECT                              ON fulfilment.products TO 'design_app'@'%';
GRANT SELECT                              ON fulfilment.sanitise TO 'design_app'@'%';
GRANT INSERT                              ON fulfilment.notes    TO 'design_app'@'%';

FLUSH PRIVILEGES;
```

`internal_notes` (added 2026-08-04) lets office staff flag order-specific
instructions (e.g. "customer very particular about layout") that surface as a red
warning banner at the top of that order's block in the queue — read-only, same
column-level-grant pattern as `id`/`status`.

Note on `notes`: INSERT only, no SELECT — the app writes a one-way audit breadcrumb
("Design Queue: Order #N DESIGNED by Andy") the moment the FIRST line in an order
goes off→on for a given tick kind (an order has exactly one designer and one
verifier, so this fires once per order per kind, not once per line) — so if a wrong
product ever reaches a customer, the order's audit trail shows who designed and who
verified it.
Unticking writes nothing (no correction trail, by design). This is
separate from and does not replace `data/ticks.json`, which remains
the live/current tick state the UI reads — the comment is a
breadcrumb, not a data source. Confirmed against the real `notes`
table (columns `order_id`, `user_id`, `content`, `created_at`,
`updated_at`) — `lib/audit.js` is up to date.

Notes:
- If the DO database has "trusted sources" configured, the droplet is
  presumably already listed (order_app connects from it) — no change
  needed.
- The connection uses TLS (`"ssl": true` in config, already set). For
  full certificate verification, download `ca-certificate.crt` from
  the DO database dashboard, place it next to config.json, and add
  `"caFile": "ca-certificate.crt"` under `db`.

## 2. App setup

Code lives in git — `EngravingStudios/engraving-design-queue` (private),
same pattern as `engraving-automation`/`engraving-orders`: a dedicated
deploy key per repo, wired up via an SSH host alias in `~/.ssh/config`.

```
Host github-design-queue
  HostName github.com
  User git
  IdentityFile ~/.ssh/deploy_engraving_design_queue
  IdentitiesOnly yes
```

On a fresh box, clone it in:

```bash
cd /var/www            # or wherever your apps live
git clone github-design-queue:EngravingStudios/engraving-design-queue.git design-queue
cd design-queue
```

On this droplet it's already cloned at `/var/www/design-queue` — pull
future updates with `git pull` from that directory instead of
re-cloning. `node_modules/`, `config.json`, and `data/` are gitignored
(local/instance-specific, never committed).

Every secret this app needs — the design_app DB password, the shared
staff login's bcrypt hash, and the session-signing secret — lives in
the central `/etc/orders-app/config.php`, not in this app's own
`config.json`. This mirrors the existing `db_automation` block already
in that file (one block per app's DB user), extended to cover the
app's local secrets too, so nothing credential-shaped sits in this
app's own folder or its git history.

```bash
npm install
mkdir -p data           # holds ticks.json, product-colours.json, and
                         # sessions/ (login sessions — file-backed so
                         # restarts don't log everyone out) — working
                         # state only, safe to wipe if ever needed
cp config.example.json config.json
```

That's it for `config.json` — every value in the template that used to
be a `PASTE_` placeholder is now an `@shared:` reference, so the
copied file needs no local edits. (Only `auth.username` stays a plain
local value — a username isn't a secret.)

Generate the two secrets:

```bash
node hash-password.js 'the-shared-password-you-chose'   # → design_queue.password_hash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → design_queue.session_secret
```

**Process ownership (as of 2026-08-04):** this app runs as a dedicated,
non-root system user, `svc-designqueue` — not root, and not shared with
any other app on the droplet. `/var/www/design-queue` (including `.git`,
`data/`, `config.json`) is owned by that user; run `git pull`, `npm
install`, etc. as `sudo -u svc-designqueue -H bash -lc '...'` rather
than as root or your own login user, so ownership stays consistent.

Add three things to `/etc/orders-app/config.php` — the design_app DB
password chosen in §1, and the two secrets just generated:

```php
'db_design' => [
    'host'     => '<same host as the existing db block>',
    'port'     => 25060,
    'database' => 'fulfilment',
    'username' => 'design_app',
    'password' => '<the password you chose in §1>',
],
'design_queue' => [
    'password_hash'  => '<output of hash-password.js>',
    'session_secret' => '<output of the randomBytes command>',
],
```

`config.json` references these as `@shared:db_design.host`,
`@shared:design_queue.password_hash`, etc. (already set up that way in
the template). The loader runs `php -r` at startup to read the central
file, so rotating any of these later means editing `config.php` once
and `pm2 restart design-queue` — never editing `config.json`.
Requirements:
- `php` CLI on the droplet (already there — the orders app is PHP)
- the design-queue's Linux user (`svc-designqueue`) can read
  `/etc/orders-app/config.php` — granted via membership in the
  `orders-secrets` group (file is `root:orders-secrets`, mode `640`),
  not via ownership. See the `orders` repo's CLAUDE.md for the shared
  permission model.
Missing or typo'd references fail loudly at startup rather than
half-starting the app.

Make sure the `data/` folder is writable by whichever user runs the
app — on this droplet that's `svc-designqueue`, a dedicated non-root
system user (not shared with any other app here).

Test run before PM2:

```bash
sudo -u svc-designqueue -H bash -lc 'cd /var/www/design-queue && node server.js'
# should print: Design Queue listening on 127.0.0.1:3050 under /design
# Ctrl+C to stop
```

Then:

```bash
sudo -u svc-designqueue -H bash -lc 'cd /var/www/design-queue && pm2 start server.js --name design-queue && pm2 save'
```

PM2 for this user is kept alive across reboots by the systemd unit
`pm2-svc-designqueue` (enabled via `pm2 startup systemd -u svc-designqueue
--hp /home/svc-designqueue`, run once as root).

---

## 3. Nginx

### 3a. Allowlist file — `/etc/nginx/snippets/design-allowlist.conf`

```nginx
allow 212.139.46.161;  # Workshop fixed IP
allow 217.146.82.84;   # Surfshark VPN static
allow 80.177.191.116;  # Andy home (update as needed)
deny all;
```

### 3b. Location block — add inside the existing
`automation.engravingstudios.co.uk` server block:

```nginx
location /design {
    include /etc/nginx/snippets/design-allowlist.conf;
    add_header X-Robots-Tag "noindex, nofollow" always;

    proxy_pass http://127.0.0.1:3050;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket — required
    proxy_set_header Connection "upgrade";       # WebSocket — required
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 86400;                    # keep sockets alive
}
```

Then:

```bash
nginx -t && nginx -s reload
```

Do NOT add /design to robots.txt — the noindex header does the job
without advertising the path.

---

## 4. Verification checklist

1. From an allowed IP: https://automation.engravingstudios.co.uk/design
   → login page. Wrong password rejected; right password → queue.
2. From a non-allowed IP (e.g. phone on mobile data): connection
   refused / 403. 
3. Header says "Live" (green dot) — WebSocket connected. If it says
   Offline but the page loaded, the Upgrade headers are missing.
4. Open the queue on two devices; tick a box on one → appears on the
   other within a blink, with name + time.
5. Click a plate → paste somewhere → text matches the engraving exactly.
6. Tick every line in a small batch → Move button turns green → move →
   toast + tab counts update on both devices.
7. Raise a test issue → ticket appears in HelpScout mailbox 240303 →
   order vanishes from the queue (status = pending).
8. Check the logs after first load (`pm2 logs design-queue`) — any
   product_id=0 items in the batch should log a `[unmapped-report]`
   line and raise one HelpScout ticket (in-memory dedup only, no
   table — restarting the app may re-raise one ticket per name still
   unmapped, which is expected).

## 5. Day-2 notes

All `pm2`/log commands below run as the `svc-designqueue` system user, e.g.
`sudo -u svc-designqueue -H pm2 restart design-queue` — not as root.

- Add/remove staff: edit `staff` in config.json, `pm2 restart design-queue`.
- Change batch/status names: `statuses` in config.json.
- Exclude more groups: `excludedGroupIds` in config.json.
- Rotate the shared login password, session secret, or the design_app
  DB password: edit the relevant value under `design_queue` or
  `db_design` in `/etc/orders-app/config.php`, then
  `pm2 restart design-queue`. Never edit config.json for these — it
  only holds `@shared:` references, no local secrets.
- Every product gets a permanent colour automatically (hash of its
  product_id — no setup needed). To hand-pick one instead, edit
  `data/product-colours.json`: `{"142": "#5aa9e6"}` — picked up within
  a minute, no restart needed.
- Tick data lives in `data/ticks.json`. It expires on its own after 3
  days — nothing to maintain. Safe to delete the file if you ever want
  to clear all current ticks (e.g. testing); the app recreates it.
- Login sessions live in `data/sessions/` (file-backed, survives
  `pm2 restart design-queue` — see SPEC.md §12). If someone reports
  being stuck disconnected/unable to log in right after a restart on a
  browser that was open from *before* this fix was deployed, it's a
  stale cookie from the old in-memory store — clear cookies for the
  site and log back in. Shouldn't recur going forward.
- Home IP changed: edit the allowlist snippet, `nginx -s reload`.
- Logs: `pm2 logs design-queue`. Issue-ticket failures appear here —
  if HelpScout is down, the order is NOT moved to pending (deliberate:
  no order ever parks in pending without a ticket behind it).
- Back up `data/` alongside your normal droplet backups if you want
  belt-and-braces on in-flight ticks — not critical (they self-expire
  and staff can re-tick in seconds), but free insurance if you're
  already snapshotting the box.
