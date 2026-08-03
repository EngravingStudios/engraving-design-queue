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

GRANT SELECT (id, status)     ON fulfilment.orders   TO 'design_app'@'%';
GRANT UPDATE (status)         ON fulfilment.orders   TO 'design_app'@'%';
GRANT SELECT (id, order_id)   ON fulfilment.items    TO 'design_app'@'%';
GRANT SELECT                  ON fulfilment.products TO 'design_app'@'%';
GRANT SELECT                  ON fulfilment.sanitise TO 'design_app'@'%';
GRANT INSERT                  ON fulfilment.notes    TO 'design_app'@'%';

FLUSH PRIVILEGES;
```

Note on `notes`: INSERT only, no SELECT — the app writes a one-way
audit breadcrumb ("Design Queue: item N DESIGNED by Andy") the moment
a tick goes off→on, so if a wrong product ever reaches a customer,
the order's audit trail shows who designed and who verified it.
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

Every secret this app needs — the design_app DB password, the shared
staff login's bcrypt hash, and the session-signing secret — lives in
the central `/etc/orders-app/config.php`, not in this app's own
`config.json`. This mirrors the existing `db_automation` block already
in that file (one block per app's DB user), extended to cover the
app's local secrets too, so nothing credential-shaped sits in this
app's own folder.

```bash
cd /var/www            # or wherever your apps live
# copy the design-queue folder here, then:
cd design-queue
npm install
mkdir -p data           # holds ticks.json + product-colours.json —
                         # working state only, safe to wipe if ever needed
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
- the design-queue's Linux user can read /etc/orders-app/config.php
Missing or typo'd references fail loudly at startup rather than
half-starting the app.

Make sure the `data/` folder is writable by whichever user runs the
app (same user as everything else here — no special permissions
needed, it's a normal folder inside the app's own directory).

Test run before PM2:

```bash
node server.js
# should print: Design Queue listening on 127.0.0.1:3050 under /design
# Ctrl+C to stop
```

Then:

```bash
pm2 start server.js --name design-queue
pm2 save
```

---

## 3. Nginx

### 3a. Allowlist file — `/etc/nginx/snippets/design-allowlist.conf`

```nginx
allow 212.139.46.161;  # Workshop fixed IP
allow 217.146.82.84;   # Surfshark VPN static
allow 90.246.27.41;    # Andy home (update as needed)
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
- Home IP changed: edit the allowlist snippet, `nginx -s reload`.
- Logs: `pm2 logs design-queue`. Issue-ticket failures appear here —
  if HelpScout is down, the order is NOT moved to pending (deliberate:
  no order ever parks in pending without a ticket behind it).
- Back up `data/` alongside your normal droplet backups if you want
  belt-and-braces on in-flight ticks — not critical (they self-expire
  and staff can re-tick in seconds), but free insurance if you're
  already snapshotting the box.
