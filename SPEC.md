# ES Design Queue — Build Specification

Live multi-screen workshop display for Engraving Studios. Staff work
through batches of orders, copy engraving text into EngraveLab, tick
designed/verified per line, all screens update instantly.

Reference implementation is included in this package (`server.js`,
`lib/`, `public/`) — tested and working against real sample data.
Treat it as the working starting point, not just a spec to reimplement
from scratch. This document explains the *why* behind every decision
so nothing gets "simplified" back to a generic version by mistake.

---

## 1. Non-negotiable constraints

- **Zero fulfilment database schema changes.** No new columns, no new
  tables. The app only SELECTs from `orders`, `items`, `products`,
  `sanitise`. The ONE exception: `UPDATE orders SET status=...` for
  batch-move and issue-raising — that's the app's actual job, not
  incidental state.
- **Database is DigitalOcean managed MySQL** (remote host, port
  25060, requires TLS). Not local to the droplet.
- **Central secrets file already exists** at `/etc/orders-app/config.php`
  (PHP array, `return [...]`). Rotate a key there once, not per-app.
  Don't duplicate secrets into this app's own config.
- **Deployment target:** existing droplet, `automation.engravingstudios.co.uk/design`,
  own PM2 process, behind the same Nginx as other apps there.
- **Must never be indexed** by search engines (private, contains
  customer data).
- **Must be IP-restricted** (fixed workshop IP + VPN IP + home IP) AND
  behind a login — belt and braces, not either/or.

---

## 2. Data model & the aliasing problem

- `items.product_id` → `products.id` → `products.group_id` →
  `productGroups`. The import API already resolves marketplace names
  to `product_id` (via an `other_names` table upstream) — **this app
  never touches `other_names`**, it just reads the resolved `product_id`.
- `items.product_id = 0` means unmatched. Show these in a distinct
  "Unmapped" section using the raw item name, never hide them.
  Real-world unmapped rate: ~1%.
- Group/section the queue by **`products.name`** (product-level, not
  a coarser "type") — this is deliberate: different tag sizes (21mm
  vs 27mm) are different products and must be different sections,
  because that's exactly the level at which the "different product in
  a mixed order" warning (§6) needs to operate.
- **Exclude `group_id = 15`** (fixings: rings, screws, TagLock) from
  the view entirely. An order containing ONLY excluded items still
  moves with its batch (batch moves are status-driven, never
  screen-driven) but shows nowhere in the UI. Orders with a MIX of
  excluded + real items show only the real items, plus a small
  "+N non-design items in this order (not shown)" note.
- Engraving fields: `items.front_engraving`, `items.back_engraving`.
  Either or both may be NULL/empty. Back-only never occurs in
  practice but front-only is common (~50%). A small number of
  currently-unverified ("paid" status) items can have BOTH blank —
  never occurs by the time an order reaches print_batch_1, so no
  special handling needed, just render empty plates as a harmless
  fallback.
- Order number shown to users = `orders.id`, and it's a **clickable
  link** to `https://fulfilment.engravingstudios.co.uk/orders/{id}`
  (opens new tab).

## 3. Sanitise (mission-critical, do not skip)

A `sanitise` table (`find`, `replace` columns) holds find/replace
rules — curly quotes → straight, em-dash → hyphen, HTML entities
(`&#39;`), and common misspellings (`speyed`→`spayed`,
`microchiped`→`microchipped`). Load from DB (cache ~60s), apply to
**both** front and back engraving before EVERYTHING downstream:
display, clipboard copy, sort-tier word counts, and similarity
comparison. Read-time transform only — database rows are never
modified.

Two rule types, auto-detected:
- **Word rules** (purely alphabetic `find`): match **case-insensitively**,
  replacement **mirrors the customer's typed casing**
  (`speyed`→`spayed`, `Speyed`→`Spayed`, `SPEYED`→`SPAYED`). This was
  an explicit design decision — do not make word rules case-sensitive.
- **Literal rules** (symbols/entities): exact literal replace,
  casing is meaningless here.

Applied in `id` order from the table. Normalise `\r\n`/`\r` → `\n`
first. Empty string or literal `"NULL"` after trim → treat as null.

## 4. Grouping, sorting, colours

**Product colour: full hue-wheel hash of `product_id`** (NOT a fixed
palette — an earlier fixed 12-colour palette was explicitly rejected
as too small; there are 300+ products). `hsl(hash(id) % 360, 58%, 56%)`.
Deterministic, permanent, same product = same colour every day,
forever, zero setup. Optional override file `data/product-colours.json`
(`{"142": "#5aa9e6"}`) for hand-picking specific ones — starts empty,
hot-reload on ~60s cache, no restart needed.

**Sort tiers within each product group** (this exact three-way split,
confirmed explicitly, do not simplify):
1. Front AND back both populated, BOTH sides more than 1 word
2. Front AND back both populated, one or both sides ≤ 1 word
   (e.g. a name front + phone number back — single-word NAME is what
   matters, not the word count of a phone number)
3. Only one side populated (single-sided item)

**Real bug this needed fixing for**: a bare phone number has no
internal spaces, so it always counts as "1 word" — even an 11-digit
one. That's fine when the OTHER side is genuinely short too (a
single-word name front, e.g. "ARLO" — correctly tier 2, per the
example above). But when the other side is a full multi-word address
(e.g. a name + house number + street + postcode, several words), the
whole item was still getting dragged into tier 2 purely because the
phone-number side's word count is mechanically 1 — even though the
front is clearly substantial, tier-1-shaped content. Fix: a side whose
text is purely digits (≥6 characters, spaces stripped) is treated as
satisfying the "more than 1 word" check regardless of its literal word
count — a phone number's *length* is what makes it non-trivial, not
its whitespace-delimited word count. A genuinely short side (like a
bare first name) still isn't exempted, since it doesn't match that
digits-only pattern.

Within each tier: **quantity descending**.

**Multi-line orders**: an order with >1 designable line gets a dashed
gold border wrapping the whole block, so staff know to prepare
matching layouts together. This applies to ANY multi-line order, not
just ones spanning multiple products (that's a separate, stronger
signal — see §6).

**Order position in the queue**: an order's position is determined
SOLELY by its first line's sort-tier + qty. Remaining lines keep
their original order and stay attached to the block — never
reordered independently, never split apart. Two tags on the same
order always render adjacent, guaranteed.

**Quantity display**: large `×N` block, positioned before the tick
boxes, glows amber when qty > 1.

**Group heading**: shows `Quantity: N` = **total unit count** (sum of
qty across all lines in that product's section), not line count.

## 5. Similarity detection (within an order only)

For items on the SAME order, compute similarity via Levenshtein ratio
(`1 - distance/maxLength`), comparing **front-vs-front and
back-vs-back independently** and taking whichever side scores higher.
Threshold **0.65**, tunable.

**Real bug this was fixed from**: the first version concatenated
front+back into one string before comparing (`combinedText()`). That
dilutes the signal whenever one side is near-identical but the other
is completely different — e.g. two siblings' pet tags, same
owner/address/phone on the front (only the pet's name differs), but
totally different medical-note text on the back. The huge back-text
edit distance dragged the *combined* ratio well below 0.65 even though
the front alone was a ~95% match — exactly the "did you grab the wrong
tag" case this feature exists to catch (see the 27mm/21mm motivating
example below). Comparing the two sides independently and taking the
max fixes it: a near-identical front now triggers the warning
regardless of how different the back is, and vice versa.

- **Identical** → no warning (genuinely the same design).
- **Similar but NOT identical** (≥0.65, <1.0) → red banner: "⚠
  Similar item in this order — NOT identical, differences highlighted".
  Word-level diff (LCS-based) with the differing words wrapped in
  `<mark>` directly on the plate text — highlights exactly the changed
  digit/word (e.g. a differing phone number digit), not the whole
  field.
- **Clearly different** → no warning; keeps the signal meaningful.

**Deliberately scoped to within-order only** — cross-order similarity
(two different customers, similar tags) was explicitly rejected as
noise that would train staff to ignore the warning.

**Critical implementation detail**: the plate's clipboard copy must
use the RAW source text, never the rendered/highlighted DOM text —
copy from a separate registry of source strings, not `.innerText`.
(A real bug: `<mark>` inside a flex-centred container broke line
wrapping visually AND leaked into clipboard output. Fix: wrap plate
text in a single inner `<span>` so `<br>`/`<mark>` flow correctly
inside the flex container, and always copy from source data.)

**Second real bug, cross-browser**: the source registry (and every
other use of the text — sort, diff, similarity) uses plain `\n` line
breaks. Chrome auto-converts `\n` to `\r\n` when writing plain text to
the system clipboard; Firefox writes it verbatim. EngraveLab's paste
target only recognises `\r\n` as a line break, so Firefox pastes were
silently losing line spacing while Chrome looked fine. Fix: normalise
`\n` → `\r\n` at the point of writing to the clipboard only (in
`doCopy()`), never in the source registry itself — sort/diff/similarity
must keep operating on plain `\n`.

## 6. Different-product-in-mixed-order warning

Two SEPARATE signals, don't conflate them:

1. **Multi-line order** (§4) → gold dashed wrapper, informational only.
2. **A line whose product differs from the group it's sorted under**
   (i.e. an order mixing products, and this specific line isn't the
   group's product) → **red banner** on that line (same red as
   similarity warnings), reading "Mixed order #{id} — {product} —
   different product!", PLUS clicking either plate on that line
   triggers a confirmation modal: "You're working through {group
   product}, but this line is a {actual product}. Did you notice it's
   a different product?" — Cancel / "Yes — copy it". Once confirmed
   for that line, don't re-nag on the second plate (front vs back) —
   track acknowledged lines by item ID.

Real motivating example: a run of 27mm brass tags with one 21mm tag
buried in a mixed order — human nature assumes visual similarity means
identity; this call-out exists specifically to break that assumption.

## 7. Ticks — file-based, NOT database (final decision after iteration)

**Do not add database columns or an audit-comment trail.** Ticks are
short-lived working state (useful for ~3 days while a batch is live,
worthless once shipped) — a flat file matches that lifespan; a
database schema change or permanent audit trail does not.

`data/ticks.json` inside the app's own folder:
```json
{ "<itemId>": { "designed_by": "Andy", "designed_at": "<ISO8601>",
                 "verified_by": "Mandy", "verified_at": "<ISO8601>" } }
```
- Held in memory for instant reads; **no per-tick disk read**.
- Writes are debounced (~300ms) and atomic (write temp file, rename)
  — safe under concurrent ticks from multiple tablets.
- **Untick = delete the two fields, no history kept.** This was an
  explicit simplification after considering (and rejecting) a
  database audit-comments approach — no audit trail is needed or
  wanted for ticks.
- **Auto-prune** entries whose most recent tick timestamp is >3 days
  old — run on startup and every 24h.
- Survives normal PM2 restarts (reads from disk on boot). Does NOT
  survive moving to a different server — acceptable, known trade-off.

**Live sync is unaffected by file-vs-DB.** Tick flow: click → server
updates in-memory state (microseconds) → Socket.IO broadcasts to
every connected screen immediately → disk write happens after, in the
background, debounced. Persistence and live-push are decoupled;
going file-based cost zero latency (if anything it's faster than the
DB round-trip it replaced).

Focus-advance: after any tick, auto-scroll to the next un-done line
(same order-of-appearance as rendered) so designers can work down a
batch without manual scrolling. Scrolls it to the **top** of the view,
not centred — centring still left earlier lines visible above the
focused one, cluttering the view exactly when you're trying to work
through a long batch. Can't just use `scrollIntoView({block:"start"})`:
there are two stacked sticky layers (the main header, then each
group's `.type-break` heading right below it) that scrollIntoView
doesn't know to leave room for, so the line would land tucked behind
them. Both are measured live and the scroll target lands just under
them instead.

## 7a. Audit trail — one-way comment on tick-ON (separate from §7)

`data/ticks.json` (§7) is the live/current state the UI reads — it
has no history and expires. Separately, `lib/audit.js` writes ONE
comment to the existing `notes` table the moment a tick goes
**OFF→ON only**: `"Design Queue: item {itemId} {DESIGNED|VERIFIED} by
{user}"`, via `orders.id` resolved from the item. Purpose: if a wrong
product reaches a customer, opening that order's audit trail shows
who designed and who verified it, without the app needing to be open.

- **Unticking writes nothing** — no correction/removal comment. This
  was explicitly requested; don't add one "for completeness".
- **Fire-and-forget, off the tick's critical path.** `setTick()`
  updates `ticks.json` and returns immediately (as in §7); the order
  lookup + comment INSERT happen afterwards, asynchronously. This
  matters: an earlier draft accidentally awaited the DB lookup inside
  `setTick`, which would have added a network round-trip to every
  tick's Socket.IO broadcast — verified fixed with a timing test
  (setTick returns in ~15ms even with a 150ms DB stub behind it).
  Keep it this way; do not await the audit write in the tick handler.
- `notes` table columns used: `order_id`, `user_id` (written as
  `0`, matching the existing default for system-written rows —
  confirmed acceptable), `content`, `created_at`, `updated_at`.
  Confirmed against the real table (`lib/audit.js` has them as named
  constants).
- DB grant needed: `INSERT` only on `notes` — no `SELECT`, this
  app never reads rows back, only appends.

## 8. Batches, statuses, move-to-Label-Hold

Real status VALUES stored in `orders.status`:
- `print_1st_batch` → label "Batch 1"
- `print_2nd_batch` → label "Batch 2"
- `print_3rd_batch` → label "Batch 3"
- `print_4th_batch` → label "Batch 4"
- `label_hold` → label "Label Hold" (combined destination)
- `pending` → label "Pending" (issue destination)

Tabs = one per batch + Label Hold, each showing live order count.
Batches are assigned to orders by staff each morning in the
**fulfilment system**, not this app — this app only reads/displays
existing status, never assigns initial batching.

**Move button**: appears per-batch-tab, disabled/grey until every
visible line in that batch is BOTH designed AND verified, then turns
green. Requires a "Working as" name selected first, same as ticking
and raising an issue — block with a toast if not (needed for the
audit breadcrumb below). On click:
- Server-side check (in a locked transaction, `SELECT ... FOR UPDATE`)
  whether Label Hold already has orders — **never trust a client's
  cached view of the target**, always re-check at move time.
- If empty → move silently (all orders with that batch status →
  `label_hold`), toast confirmation.
- If occupied → warning modal: "Label Hold already contains N orders.
  Moving will combine them into one batch." (no need to list order
  numbers, just the count) → Cancel / "Yes, combine and move".
- **The move is status-driven, not screen-driven**: ALL orders with
  the batch status move, including ones invisible on screen (e.g.
  fixings-only orders that got excluded from view by §2). Nothing can
  be stranded in a batch.
- Volume note: expect up to ~100 orders in any given status at a
  time — moves are infrequent, no special performance concern.
- **Audit breadcrumb, one per order**: same mechanism as §7a/§9 —
  after the move transaction commits, `lib/audit.js` writes
  `"Design Queue: Order #{id} moved to {targetLabel} by {user}"` to
  `notes` for every order that moved (the order IDs are captured via
  `SELECT ... FOR UPDATE` inside the same transaction that performs
  the move, not re-derived from the `UPDATE`'s affected-row count, so
  the breadcrumb always matches exactly which orders moved). Awaited
  before the response returns, not fire-and-forget — same reasoning
  as §9: moves are infrequent, not a latency-sensitive path.
- **Loading state while waiting on the response**: because the audit
  breadcrumb writes above are awaited before the server responds, a
  large batch (up to ~100 orders, per the volume note) can take a
  visible moment. Without a loading indicator this looked like nothing
  was happening — the move was working, just invisibly. Button shows
  a spinner + "Moving…" and disables itself the instant it's clicked;
  on success it's naturally rebuilt fresh once the server's own
  `orders_changed` broadcast triggers a re-render (no manual reset
  needed), on error/conflict it resets immediately.

## 9. Issue flag → HelpScout → Pending

Per-line "⛔ Issue" button (red on hover), positioned right of the
Verified tick. Opens a modal requiring free-text notes (blocked until
non-empty) — "this will create a HelpScout ticket and move the ORDER
(not just the line) to Pending, removing it from every screen
instantly."

On submit: **create HelpScout ticket FIRST** (mailbox ID from central
config, includes order link, staff name, notes, and every line's
product/qty/front/back for context) — **only if ticket creation
succeeds**, then `UPDATE orders SET status='pending'`, then write a
one-way audit breadcrumb to `notes` — same mechanism and reasoning as
the tick audit trail (§7a): `"Design Queue: {user} raised an issue at
the design stage — "{notes}""`, via `lib/audit.js`. If the ticket API
fails, the order must NOT move — never leave an order silently parked
in Pending with no ticket behind it. Broadcast the removal via
Socket.IO so it vanishes from every screen immediately (this falls
out naturally from status-filtered queries — no special-case code
needed beyond re-querying/broadcasting).

Unlike the tick audit write (which is fire-and-forget, off the
critical path — see §7a), this one is awaited: issue-raising isn't a
high-frequency action the way ticking is, there's no Socket.IO
broadcast latency to protect, and reliability of the paper trail
matters more here than shaving a DB round-trip.

## 10. Unmapped product reporting

When the queue encounters `product_id = 0` items, batch up the
distinct raw names and raise ONE HelpScout ticket per newly-seen name
(dedup so the same unmapped name doesn't spam a ticket every page
load). **In-memory dedup only** (a JS Set, not a database table) —
per the "no schema changes" rule; worst case after a restart is one
repeat ticket for a name that's still unmapped, which is an
acceptable trade.

## 11. UI / interaction specifics (all confirmed, don't default to something generic)

- Dark "workbench" theme, brass/gold accent (`#c9a24b`), engraving
  plates rendered in a brass gradient with dark serif-free text.
- Product group headings: large (22px+), bold, pill-shaped, coloured
  border matching the product's hash colour. **Sticky** — pin just
  below the main header while scrolling through that group, hand off
  to the next group's heading when it arrives. Header height is
  measured live (ResizeObserver) since it varies (tab wrapping,
  progress bars) — don't hardcode the sticky offset.
- Engraving plates: **front and back side by side** (not stacked),
  each labelled, text **centre-aligned** both axes, **sans-serif
  medium weight** (not monospace — was explicitly changed from an
  earlier monospace version to look more like the finished engraved
  product). Click anywhere on a plate = copy to clipboard, brief "✓
  Copied" flash overlay.
- Two separate progress bars in the header — **Designed** (blue) and
  **Verified** (green) — not one combined bar. Verified naturally
  lags Designed; that gap is meaningful and shouldn't be hidden by
  averaging them together.
- "Working as" name pills in the header: Alisha, Andy, Callum, Drew,
  Gary, James, Mandy, Mikey. Selection persists locally per device
  (localStorage) — designed for shared tablets, each tablet remembers
  its own last-selected identity. Tick attribution ("Andy · 09:14")
  requires a name to be selected first; block ticking with a toast if
  not.
- Tick boxes sized for **touch** (44px+) — this is a tablet-first UI,
  not desktop.
- Marketplace name/badge (Shopify/eBay/Amazon) explicitly REMOVED
  from line display — not needed, was in an earlier version, cut
  deliberately.
- Reconnect resync: on Socket.IO reconnect (tablet waking from sleep,
  wifi blip, server restart), refetch the current batch so any missed
  updates appear — don't rely solely on live push for state that may
  have been missed while disconnected.

## 12. Auth & network security (defence in depth, both layers required)

- **Layer 1 — Nginx IP allowlist** on the `/design` location: workshop
  fixed IP, Surfshark VPN static IP, home IP. `deny all` otherwise.
  This is enforced by Nginx, independent of the app.
- **Layer 2 — App login**: single shared username/password for all
  staff (not per-user accounts) — bcrypt hash + session secret, NEVER
  plaintext. Both live in the central secrets file (`design_queue.password_hash`,
  `design_queue.session_secret`), referenced via `@shared:` like every
  other secret this app uses — see §13. Session cookie, ~30-day
  expiry (tablets stay logged in).
- **Session store is file-backed** (`session-file-store`, writing into
  `data/sessions/` alongside `ticks.json`), not express-session's
  default in-memory store. This was found the hard way: the in-memory
  store is wiped on every process restart (deploys, crashes, reboots),
  which silently logged out every tablet regardless of the 30-day
  cookie — a routine `pm2 restart` shouldn't force a re-login.
- Both layers independently required — belt and braces was explicitly
  requested, not either/or.
- `X-Robots-Tag: noindex, nofollow` header on the Nginx location
  block. Do NOT list `/design` in robots.txt — that would advertise
  a private path publicly; the header achieves the same result
  without disclosure.
- Socket.IO must share the same session (reject unauthenticated
  socket handshakes) — the realtime channel needs the same gate as
  the HTTP routes, not a separate/weaker one.

## 13. Central secrets integration

`/etc/orders-app/config.php` is a PHP file (`<?php return [...];`)
containing `db` (order_app's managed MySQL host/port/database/username/password),
`db_automation` (automation_app's, same shape), `shopify`, `helpscout`
(client_id/client_secret/mailbox_id), and other secrets. This app's
own config references it via `"@shared:helpscout.client_id"` syntax —
resolved at startup by shelling out to
`php -r 'echo json_encode(require $argv[1]);'` (let PHP parse PHP,
don't regex it). Rotating a key means editing the central file once
and `pm2 restart design-queue` — never duplicate a secret into this
app's local config. Missing/typo'd references must fail LOUDLY at
startup, not silently at first use.

**Every credential this app uses is centralised, including its own.**
An earlier draft of this decision kept the app's own secrets
(`sessionSecret`, `auth.passwordHash`, its scoped DB user's password)
local, on the theory that shared secrets are referenced but
app-specific secrets aren't shared with anything else. That was
revisited: nothing credential-shaped should live in this app's own
folder at all, local or shared. Central config gained two new blocks
for this app specifically:

- `db_design` — this app's scoped MySQL user's host/port/database/
  username/password, in the same shape as the existing `db`/
  `db_automation` blocks (one block per app's DB user).
- `design_queue` — `password_hash` (bcrypt, for the shared staff
  login) and `session_secret` (cookie-signing secret).

`config.json` holds only `@shared:` references for all of these — see
`config.example.json`. The only genuinely local, non-secret value left
is `auth.username`, since a username isn't a credential on its own.

## 14. Database user (least privilege)

Managed DB → user host is `%`, not `localhost`. Grant SELECT only on
`orders` (id, status columns), `items`, `products`, `sanitise`, plus
UPDATE on `orders.status` only. No UPDATE on `items` at all (ticks
aren't stored there). No DELETE anywhere. This user should not be
able to read customer names/addresses/phones/emails at all —
column-level grants, not table-level, on `orders`.

## 15. Non-goals / things explicitly rejected during design

- No per-user login accounts (one shared login, name pills for
  attribution instead).
- No history/undo trail in `ticks.json` itself (§7) — but a separate
  one-way audit comment on tick-ON does exist, see §7a. Don't conflate
  the two: live state has no history, the audit breadcrumb does.
- No cross-order similarity detection (noise).
- No database schema changes of any kind, including small ones (an
  audit-comments approach was considered and explicitly rejected in
  favour of the file-based tick store).
- No fixed/capped colour palette (rejected, replaced with unbounded
  hash-to-hue).
- No robots.txt disclosure of the private path.

---

## Included reference files

- `server.js`, `lib/*.js`, `public/*.html` — working, tested
  implementation of everything above.
- `config.example.json` — annotated template incl. `@shared:` syntax
  examples matching the real central config's key names.
- `DEPLOY.md` — full runbook: SQL (just the read-only DB user, no
  schema changes), PM2, Nginx (allowlist + noindex + WebSocket
  headers), verification checklist.
- `hash-password.js` — generates the bcrypt hash for config.json.

Build/extend from this codebase rather than starting fresh — it
already encodes every decision above and has been unit-tested against
real sample data from the actual database.
