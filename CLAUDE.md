# design-queue — project context for Claude Code

## What this is
Node/Express + Socket.IO app, "ES Design Queue" — a live multi-screen workshop display at
`automation.engravingstudios.co.uk/design/`. Staff work through batches of engraving
orders, copy engraving text into EngraveLab, tick designed/verified per line, and all
screens update instantly. This document explains the *why* behind every non-obvious
decision below so nothing gets "simplified" back to a generic version by mistake — treat
the existing codebase (`server.js`, `lib/`, `public/`) as the working, tested starting
point, not just a spec to reimplement.

## Credentials
All secrets live in `/etc/orders-app/config.php` (outside this folder, shared with the
`orders` PHP app and the `automation`/`mount-stock` Node apps — never move it in here or
commit it, and nothing credential-shaped should live in this app's own `config.json` or
git history). Resolved at startup by shelling out to
`php -r 'echo json_encode(require $argv[1]);'` (let PHP parse PHP, don't regex it) —
`config.json` references central keys via `"@shared:helpscout.client_id"`-style strings;
missing/typo'd references must fail LOUDLY at startup, not silently at first use. Rotating
a key means editing `config.php` once and `pm2 restart design-queue` — never duplicate a
secret into this app's local config.

**Every credential this app uses is centralised, including its own** — an earlier draft
kept this app's own secrets (session secret, password hash, its scoped DB user's password)
local, on the theory that only *shared* secrets need centralising. That was revisited:
nothing credential-shaped belongs in this app's own folder at all, local or shared. Central
config carries two blocks for this app specifically:
- `db_design` — this app's scoped MySQL user's host/port/database/username/password, same
  shape as the `db`/`db_automation` blocks (one block per app's DB user).
- `design_queue` — `password_hash` (bcrypt, for the shared staff login) and
  `session_secret` (cookie-signing secret).

This app's own DB user is `design_app`, scoped to column-level `SELECT`/`UPDATE` grants on
`orders` (see Deployment guide §1 for the exact grant list, including `internal_notes`
added 2026-08-04) plus `SELECT` on `items`/`products`/`sanitise` and `INSERT`-only on
`notes` — never a broader-permissioned credential.

## Process ownership (as of 2026-08-04)
PM2 runs this app as a dedicated system user, `svc-designqueue` — **not root**. Managed by
systemd unit `pm2-svc-designqueue` (PM2_HOME=`/home/svc-designqueue/.pm2`); use
`sudo -u svc-designqueue -H pm2 ...` for any manual PM2 operations, and
`sudo -u svc-designqueue -H bash -lc '...'` for anything else that needs to run as the
app's own user (`git pull`, `npm install` — `/var/www/design-queue` including `.git` and
`data/` is owned by `svc-designqueue`, not root).

`svc-designqueue` is a member of the `orders-secrets` group, which is what grants read
access to `/etc/orders-app/config.php` (`root:orders-secrets`, mode `640`) — group
membership, not ownership. See the `orders` repo's CLAUDE.md for the full permission model
shared across every app on this droplet, including the recovery checklist for the "editing
config.php resets its group" gotcha.

**Important PM2 gotcha:** a plain `pm2 restart design-queue` forks from the already-running
daemon and will NOT pick up newly-added group membership (e.g. after `usermod -aG`) — that
needs a full `sudo -u svc-designqueue -H pm2 kill` followed by a fresh `pm2 start`.

---

## Behavior specification

### 1. Non-negotiable constraints
- **Zero fulfilment database schema changes.** No new columns, no new tables. The app only
  SELECTs from `orders`, `items`, `products`, `sanitise`. The ONE exception:
  `UPDATE orders SET status=...` for batch-move and issue-raising — that's the app's actual
  job, not incidental state.
- **Database is DigitalOcean managed MySQL** (remote host, port 25060, requires TLS). Not
  local to the droplet.
- **Deployment target:** existing droplet, `automation.engravingstudios.co.uk/design`, own
  PM2 process, behind the same Nginx as other apps there.
- **Must never be indexed** by search engines (private, contains customer data).
- **Must be IP-restricted** (fixed workshop IP + VPN IP + home IP) AND behind a login —
  belt and braces, not either/or.

### 2. Data model & the aliasing problem
- `items.product_id` → `products.id` → `products.group_id` → `productGroups`. The import
  API already resolves marketplace names to `product_id` (via an `other_names` table
  upstream) — **this app never touches `other_names`**, it just reads the resolved
  `product_id`.
- `items.product_id = 0` means unmatched. Show these in a distinct "Unmapped" section using
  the raw item name, never hide them. Real-world unmapped rate: ~1%.
- Group/section the queue by **`products.name`** (product-level, not a coarser "type") —
  this is deliberate: different tag sizes (21mm vs 27mm) are different products and must be
  different sections, because that's exactly the level at which the "different product in a
  mixed order" warning (§6) needs to operate.
- **Exclude `group_id = 15`** (fixings: rings, screws, TagLock) from the view entirely. An
  order containing ONLY excluded items still moves with its batch (batch moves are
  status-driven, never screen-driven) but shows nowhere in the UI. Orders with a MIX of
  excluded + real items show only the real items, plus a small "+N non-design items in this
  order (not shown)" note.
- Engraving fields: `items.front_engraving`, `items.back_engraving`. Either or both may be
  NULL/empty. Back-only never occurs in practice but front-only is common (~50%). A small
  number of currently-unverified ("paid" status) items can have BOTH blank — never occurs
  by the time an order reaches print_batch_1, so no special handling needed, just render
  empty plates as a harmless fallback.
- Order number shown to users = `orders.id`, and it's a **clickable link** to
  `https://fulfilment.engravingstudios.co.uk/orders/{id}` (opens new tab).
- `orders.internal_notes` (added 2026-08-04): free-text office-to-workshop instructions
  (e.g. "customer very particular about layout") — see §7b.

### 3. Sanitise (mission-critical, do not skip)
A `sanitise` table (`find`, `replace` columns) holds find/replace rules — curly quotes →
straight, em-dash → hyphen, HTML entities (`&#39;`), and common misspellings
(`speyed`→`spayed`, `microchiped`→`microchipped`). Load from DB (cache ~60s), apply to
**both** front and back engraving before EVERYTHING downstream: display, clipboard copy,
sort-tier word counts, and similarity comparison. Read-time transform only — database rows
are never modified.

Two rule types, auto-detected:
- **Word rules** (purely alphabetic `find`): match **case-insensitively**, replacement
  **mirrors the customer's typed casing** (`speyed`→`spayed`, `Speyed`→`Spayed`,
  `SPEYED`→`SPAYED`). This was an explicit design decision — do not make word rules
  case-sensitive.
- **Literal rules** (symbols/entities): exact literal replace, casing is meaningless here.

Applied in `id` order from the table. Normalise `\r\n`/`\r` → `\n` first. Empty string or
literal `"NULL"` after trim → treat as null. This is a single whole-string `.trim()`, not a
per-line trim — see the clipboard-copy note in §7 for why trailing whitespace on internal
lines needs separate handling.

### 4. Grouping, sorting, colours
**Product colour: full hue-wheel hash of `product_id`** (NOT a fixed palette — an earlier
fixed 12-colour palette was explicitly rejected as too small; there are 300+ products).
`hsl(hash(id) % 360, 58%, 56%)`. Deterministic, permanent, same product = same colour every
day, forever, zero setup. Optional override file `data/product-colours.json`
(`{"142": "#5aa9e6"}`) for hand-picking specific ones — starts empty, hot-reload on ~60s
cache, no restart needed.

**Sort tiers within each product group** (this exact three-way split, confirmed
explicitly, do not simplify):
1. Front AND back both populated, BOTH sides more than 1 word
2. Front AND back both populated, one or both sides ≤ 1 word (e.g. a name front + phone
   number back — single-word NAME is what matters, not the word count of a phone number)
3. Only one side populated (single-sided item)

**Real bug this needed fixing for**: a bare phone number has no internal spaces, so it
always counts as "1 word" — even an 11-digit one. That's fine when the OTHER side is
genuinely short too (a single-word name front, e.g. "ARLO" — correctly tier 2, per the
example above). But when the other side is a full multi-word address (e.g. a name + house
number + street + postcode, several words), the whole item was still getting dragged into
tier 2 purely because the phone-number side's word count is mechanically 1 — even though
the front is clearly substantial, tier-1-shaped content. Fix: a side whose text is purely
digits (≥6 characters, spaces stripped) is treated as satisfying the "more than 1 word"
check regardless of its literal word count — a phone number's *length* is what makes it
non-trivial, not its whitespace-delimited word count. A genuinely short side (like a bare
first name) still isn't exempted, since it doesn't match that digits-only pattern.

Within each tier: **quantity descending**.

**Multi-line orders**: an order with >1 designable line gets a dashed gold border wrapping
the whole block, so staff know to prepare matching layouts together. This applies to ANY
multi-line order, not just ones spanning multiple products (that's a separate, stronger
signal — see §6).

**Order position in the queue**: an order's position is determined SOLELY by its first
line's sort-tier + qty. Remaining lines keep their original order and stay attached to the
block — never reordered independently, never split apart. Two tags on the same order
always render adjacent, guaranteed.

**Quantity display**: large `×N` block, positioned before the tick boxes, glows amber when
qty > 1.

**Group heading**: shows `Quantity: N` = **total unit count** (sum of qty across all lines
in that product's section), not line count.

### 5. Similarity detection (within an order only)
For items on the SAME order, compute similarity via Levenshtein ratio
(`1 - distance/maxLength`), comparing **front-vs-front and back-vs-back independently** and
taking whichever side scores higher. Threshold **0.65**, tunable.

**Real bug this was fixed from**: the first version concatenated front+back into one string
before comparing (`combinedText()`). That dilutes the signal whenever one side is
near-identical but the other is completely different — e.g. two siblings' pet tags, same
owner/address/phone on the front (only the pet's name differs), but totally different
medical-note text on the back. The huge back-text edit distance dragged the *combined*
ratio well below 0.65 even though the front alone was a ~95% match — exactly the "did you
grab the wrong tag" case this feature exists to catch (see the 27mm/21mm motivating example
below). Comparing the two sides independently and taking the max fixes it: a near-identical
front now triggers the warning regardless of how different the back is, and vice versa.

- **Identical** → no warning (genuinely the same design).
- **Similar but NOT identical** (≥0.65, <1.0) → red banner: "⚠ Similar item in this order —
  NOT identical, differences highlighted". Word-level diff (LCS-based) with the differing
  words wrapped in `<mark>` directly on the plate text — highlights exactly the changed
  digit/word (e.g. a differing phone number digit), not the whole field.
- **Clearly different** → no warning; keeps the signal meaningful.

**Second real bug, found right after the first fix**: diff-highlighting was applied to BOTH
sides whenever the line matched at all, not just the side that actually matched. In the
siblings' pet tag example above, once the front-only match correctly triggers the banner,
the back was *also* being word-diffed against a completely unrelated sentence — since they
share almost no words, nearly the entire back plate lit up in `<mark>`, which is exactly
the "whole field highlighted" outcome this feature is meant to avoid. Fix: track which
side(s) actually hit the threshold (front, back, or both) and only diff-highlight those — a
side that didn't match renders plainly, with no highlighting at all.

**Deliberately scoped to within-order only** — cross-order similarity (two different
customers, similar tags) was explicitly rejected as noise that would train staff to ignore
the warning.

**Critical implementation detail**: the plate's clipboard copy must use the RAW source
text, never the rendered/highlighted DOM text — copy from a separate registry of source
strings, not `.innerText`. (A real bug: `<mark>` inside a flex-centred container broke line
wrapping visually AND leaked into clipboard output. Fix: wrap plate text in a single inner
`<span>` so `<br>`/`<mark>` flow correctly inside the flex container, and always copy from
source data.)

**Second real bug, cross-browser**: the source registry (and every other use of the text —
sort, diff, similarity) uses plain `\n` line breaks. Chrome auto-converts `\n` to `\r\n`
when writing plain text to the system clipboard; Firefox writes it verbatim. EngraveLab's
paste target only recognises `\r\n` as a line break, so Firefox pastes were silently losing
line spacing while Chrome looked fine. Fix: normalise `\n` → `\r\n` at the point of writing
to the clipboard only (in `doCopy()`), never in the source registry itself —
sort/diff/similarity must keep operating on plain `\n`.

**Third real bug (fixed 2026-08-04)**: customer-submitted text sometimes has trailing
spaces/tabs at the end of an INTERNAL line (not just the whole field, which §3's
`.trim()` already catches), throwing off centring once engraved. Fix: `doCopy()` strips
trailing whitespace per line (split on `\n`, strip trailing `[ \t]+`, rejoin) immediately
before the `\r\n` normalisation above — clipboard-write path only, the source registry
stays untouched since it also feeds sort/diff/similarity.

### 6. Different-product-in-mixed-order warning
Two SEPARATE signals, don't conflate them:
1. **Multi-line order** (§4) → gold dashed wrapper, informational only.
2. **A line whose product differs from the group it's sorted under** (i.e. an order mixing
   products, and this specific line isn't the group's product) → **red banner** on that
   line (same red as similarity warnings), reading "Mixed order #{id} — {product} —
   different product!", PLUS clicking either plate on that line triggers a confirmation
   modal: "You're working through {group product}, but this line is a {actual product}. Did
   you notice it's a different product?" — Cancel / "Yes — copy it". Once confirmed for
   that line, don't re-nag on the second plate (front vs back) — track acknowledged lines by
   item ID.

Real motivating example: a run of 27mm brass tags with one 21mm tag buried in a mixed
order — human nature assumes visual similarity means identity; this call-out exists
specifically to break that assumption.

### 7. Ticks — file-based, NOT database (final decision after iteration)
**Do not add database columns or an audit-comment trail** to the tick state itself (a
separate one-way audit *comment* on tick-ON does exist — see §7a — don't conflate the two).
Ticks are short-lived working state (useful for ~3 days while a batch is live, worthless
once shipped) — a flat file matches that lifespan; a database schema change or permanent
audit trail does not.

`data/ticks.json` inside the app's own folder, keyed by `itemId` (not `orderId` — there is
no persistent order→items map anywhere in the process; resolving order id from item id, or
vice versa, is always a small DB round trip, see `lib/queue.js`'s `orderIdForItem()`/
`itemIdsForOrder()`):
```json
{ "<itemId>": { "designed_by": "Andy", "designed_at": "<ISO8601>",
                 "verified_by": "Mandy", "verified_at": "<ISO8601>" } }
```
- Held in memory for instant reads; **no per-tick disk read**.
- Writes are debounced (~300ms) and atomic (write temp file, rename) — safe under
  concurrent ticks from multiple tablets.
- **Untick = delete the two fields, no history kept.** This was an explicit simplification
  after considering (and rejecting) a database audit-comments approach — no audit trail is
  needed or wanted for ticks themselves.
- **Auto-prune** entries whose most recent tick timestamp is >3 days old — run on startup
  and every 24h.
- Survives normal PM2 restarts (reads from disk on boot). Does NOT survive moving to a
  different server — acceptable, known trade-off.

**Live sync is unaffected by file-vs-DB.** Tick flow: click → server updates in-memory
state (microseconds) → Socket.IO broadcasts to every connected screen immediately → disk
write happens after, in the background, debounced. Persistence and live-push are
decoupled; going file-based cost zero latency (if anything it's faster than the DB
round-trip it replaced).

**Focus-advance**: after any tick, auto-scroll to the next un-done line (same
order-of-appearance as rendered) so designers can work down a batch without manual
scrolling. Scrolls it to the **top** of the view, not centred — centring still left earlier
lines visible above the focused one, cluttering the view exactly when you're trying to work
through a long batch. Can't just use `scrollIntoView({block:"start"})`: there are two
stacked sticky layers (the main header, then each group's `.type-break` heading right below
it) that scrollIntoView doesn't know to leave room for, so the line would land tucked
behind them. Both are measured live and the scroll target lands just under them instead.

**Fourth real bug (fixed 2026-08-04)**: the scroll anchor was the inner `.line` element
itself, not its `.line-wrap` parent — every line is wrapped in `.line-wrap`, with
`.mix-banner`/`.sim-banner` (§5/§6) rendered as siblings BEFORE `.line` inside that wrapper.
Anchoring on `.line` pushed any banner above it off-screen behind the sticky headers —
exactly the information staff most need to see on the line they've just been advanced to.
Fix: `scrollToTop()` now anchors on `line.closest('.line-wrap')||line` instead of `line`
directly; the header/type-break offset math itself was already correct.

### 7a. Audit trail — one-way comment on tick-ON, once per order (not per line)
`data/ticks.json` (§7) is the live/current state the UI reads — it has no history and
expires. Separately, `lib/audit.js` writes ONE comment to the existing `notes` table
**per order per tick kind** — the moment the FIRST line in that order goes OFF→ON for a
given kind (`"designed"` or `"verified"`): `"Design Queue: Order #{orderId}
{DESIGNED|VERIFIED} by {user}"`. Since an order has exactly one designer and one verifier,
subsequent lines in the same order ticking the same kind write nothing further — this was
changed 2026-08-04 from "one comment per line" (which produced N redundant comments on an
N-line order) to this order-level behaviour, via `lib/queue.js`'s `itemIdsForOrder()`
checking sibling ticks before calling `audit.recordTick()`. Purpose unchanged: if a wrong
product reaches a customer, opening that order's audit trail shows who designed and who
verified it, without the app needing to be open.

- **Unticking writes nothing** — no correction/removal comment. This was explicitly
  requested; don't add one "for completeness".
- **Fire-and-forget, off the tick's critical path.** `setTick()` updates `ticks.json` and
  returns immediately (as in §7); the order lookup, sibling-tick check, and comment INSERT
  happen afterwards, asynchronously. This matters: an earlier draft accidentally awaited
  the DB lookup inside `setTick`, which would have added a network round-trip to every
  tick's Socket.IO broadcast — verified fixed with a timing test (`setTick` returns in
  ~15ms even with a 150ms DB stub behind it). Keep it this way; do not await the audit write
  in the tick handler, and keep the new sibling-check inside that same async chain, not
  before `ticks.set()` returns.
- `notes` table columns used: `order_id`, `user_id` (written as `0`, matching the existing
  default for system-written rows — confirmed acceptable), `content`, `created_at`,
  `updated_at`. Confirmed against the real table (`lib/audit.js` has them as named
  constants).
- DB grant needed: `INSERT` only on `notes` — no `SELECT`, this app never reads rows back,
  only appends.

### 7b. Internal-notes warning banner (added 2026-08-04)
`orders.internal_notes` (free-text, staff-entered elsewhere) surfaces as a bold red warning
banner (`⚠` + the note text) at the top of that order's `.order-block` in the queue —
office staff instructions (e.g. "customer very particular about layout") that need to reach
the workshop floor. One banner per order (covers every line in that order via the shared
`.order-block`, not repeated per line) — chosen over per-line repetition since all lines in
an order are already visually grouped together, and it avoids clutter for multi-line
orders. Rendered via the existing `esc()` helper since it's free-text going into
`innerHTML`. Read-only, column-level grant on `orders.internal_notes` (see Deployment guide
§1) — this app never writes it.

### 8. Batches, statuses, move-to-Label-Hold
Real status VALUES stored in `orders.status`:
- `print_1st_batch` → label "Batch 1"
- `print_2nd_batch` → label "Batch 2"
- `print_3rd_batch` → label "Batch 3"
- `print_4th_batch` → label "Batch 4"
- `label_hold` → label "Label Hold" (combined destination)
- `pending` → label "Pending" (issue destination)

Tabs = one per batch + Label Hold, each showing live order count. Batches are assigned to
orders by staff each morning in the **fulfilment system**, not this app — this app only
reads/displays existing status, never assigns initial batching.

**Move button**: appears per-batch-tab, disabled/grey until every visible line in that
batch is BOTH designed AND verified, then turns green. Requires a "Working as" name
selected first, same as ticking and raising an issue — block with a toast if not (needed
for the audit breadcrumb below). On click:
- Server-side check (in a locked transaction, `SELECT ... FOR UPDATE`) whether Label Hold
  already has orders — **never trust a client's cached view of the target**, always
  re-check at move time.
- If empty → move silently (all orders with that batch status → `label_hold`), toast
  confirmation.
- If occupied → warning modal: "Label Hold already contains N orders. Moving will combine
  them into one batch." (no need to list order numbers, just the count) → Cancel /
  "Yes, combine and move".
- **The move is status-driven, not screen-driven**: ALL orders with the batch status move,
  including ones invisible on screen (e.g. fixings-only orders that got excluded from view
  by §2). Nothing can be stranded in a batch.
- Volume note: expect up to ~100 orders in any given status at a time — moves are
  infrequent, no special performance concern.
- **Audit breadcrumb, one per order**: same mechanism as §7a/§9 — after the move
  transaction commits, `lib/audit.js` writes `"Design Queue: Order #{id} moved to
  {targetLabel} by {user}"` to `notes` for every order that moved (the order IDs are
  captured via `SELECT ... FOR UPDATE` inside the same transaction that performs the move,
  not re-derived from the `UPDATE`'s affected-row count, so the breadcrumb always matches
  exactly which orders moved). Awaited before the response returns, not fire-and-forget —
  same reasoning as §9: moves are infrequent, not a latency-sensitive path.
- **Loading state while waiting on the response**: because the audit breadcrumb writes
  above are awaited before the server responds, a large batch (up to ~100 orders, per the
  volume note) can take a visible moment. Without a loading indicator this looked like
  nothing was happening — the move was working, just invisibly. Button shows a spinner +
  "Moving…" and disables itself the instant it's clicked; on success it's naturally rebuilt
  fresh once the server's own `orders_changed` broadcast triggers a re-render (no manual
  reset needed), on error/conflict it resets immediately.

### 9. Issue flag → HelpScout → Pending
Per-line "⛔ Issue" button (red on hover), positioned right of the Verified tick. Opens a
modal requiring free-text notes (blocked until non-empty) — "this will create a HelpScout
ticket and move the ORDER (not just the line) to Pending, removing it from every screen
instantly."

On submit: **create HelpScout ticket FIRST** (mailbox ID from central config, includes
order link, staff name, notes, and every line's product/qty/front/back for context) —
**only if ticket creation succeeds**, then `UPDATE orders SET status='pending'`, then write
a one-way audit breadcrumb to `notes` — same mechanism and reasoning as the tick audit
trail (§7a): `"Design Queue: {user} raised an issue at the design stage — "{notes}""`, via
`lib/audit.js`. If the ticket API fails, the order must NOT move — never leave an order
silently parked in Pending with no ticket behind it. Broadcast the removal via Socket.IO so
it vanishes from every screen immediately (this falls out naturally from status-filtered
queries — no special-case code needed beyond re-querying/broadcasting).

Unlike the tick audit write (which is fire-and-forget, off the critical path — see §7a),
this one is awaited: issue-raising isn't a high-frequency action the way ticking is,
there's no Socket.IO broadcast latency to protect, and reliability of the paper trail
matters more here than shaving a DB round-trip.

### 10. Unmapped product reporting
When the queue encounters `product_id = 0` items, batch up the distinct raw names and
raise ONE HelpScout ticket per newly-seen name (dedup so the same unmapped name doesn't
spam a ticket every page load). **In-memory dedup only** (a JS Set, not a database table) —
per the "no schema changes" rule; worst case after a restart is one repeat ticket for a
name that's still unmapped, which is an acceptable trade.

### 11. UI / interaction specifics (all confirmed, don't default to something generic)
- Dark "workbench" theme, brass/gold accent (`#c9a24b`), engraving plates rendered in a
  brass gradient with dark serif-free text.
- Product group headings: large (22px+), bold, pill-shaped, coloured border matching the
  product's hash colour. **Sticky** — pin just below the main header while scrolling
  through that group, hand off to the next group's heading when it arrives. Header height
  is measured live (ResizeObserver) since it varies (tab wrapping, progress bars) — don't
  hardcode the sticky offset.
- Engraving plates: **front and back side by side** (not stacked), each labelled, text
  **centre-aligned** both axes, **sans-serif medium weight** (not monospace — was
  explicitly changed from an earlier monospace version to look more like the finished
  engraved product). Click anywhere on a plate = copy to clipboard, brief "✓ Copied" flash
  overlay.
- Two separate progress bars in the header — **Designed** (blue) and **Verified** (green) —
  not one combined bar. Verified naturally lags Designed; that gap is meaningful and
  shouldn't be hidden by averaging them together.
- "Working as" name pills in the header: Alisha, Andy, Callum, Drew, Gary, James, Mandy,
  Mikey. Selection persists locally per device (localStorage) — designed for shared
  tablets, each tablet remembers its own last-selected identity. Tick attribution
  ("Andy · 09:14") requires a name to be selected first; block ticking with a toast if not.
- Tick boxes sized for **touch** (44px+) — this is a tablet-first UI, not desktop.
- Marketplace name/badge (Shopify/eBay/Amazon) explicitly REMOVED from line display — not
  needed, was in an earlier version, cut deliberately.
- Reconnect resync: on Socket.IO reconnect (tablet waking from sleep, wifi blip, server
  restart), refetch the current batch so any missed updates appear — don't rely solely on
  live push for state that may have been missed while disconnected.

**Real bug, easy to misdiagnose as a cookie/session problem**: the Socket.IO client script
was loaded via a plain relative `<script src="socket.io/socket.io.js">`. Relative URLs
resolve differently depending on whether the page URL has a trailing slash — `/design/`
resolves it to `/design/socket.io/socket.io.js` (correct), but `/design` with no trailing
slash (a bookmark, address-bar autocomplete, a typed URL — all common) resolves it to
`/socket.io/socket.io.js` at the domain root instead, which 404s. Since the 404 response is
Express's default HTML error page, the browser refuses to execute it as a script (MIME
type mismatch), so `io` is never defined — and the very next line
(`const socket = io(...)`) throws, silently killing the rest of the page's script before
anything else runs, including the code that would show "Live", populate the "Working as"
pills, or load the queue. The page itself still loads fine (it's a separate request),
which is what made this look like an auth/cookie issue: the header renders, the socket
status just sits frozen on the hardcoded initial "Connecting" text forever, with no staff
pills. Fix: compute the script's path explicitly via `document.write` using the same
`location.pathname.replace(/\/$/, "")` logic already used everywhere else in this file for
`BASE`, rather than relying on the browser's relative-URL resolution.

### 12. Auth & network security (defence in depth, both layers required)
- **Layer 1 — Nginx IP allowlist** on the `/design` location: workshop fixed IP, Surfshark
  VPN static IP, home IP. `deny all` otherwise. This is enforced by Nginx, independent of
  the app.
- **Layer 2 — App login**: single shared username/password for all staff (not per-user
  accounts) — bcrypt hash + session secret, NEVER plaintext. Both live in the central
  secrets file (`design_queue.password_hash`, `design_queue.session_secret`), referenced
  via `@shared:` like every other secret this app uses — see Credentials above. Session
  cookie, ~30-day expiry (tablets stay logged in).
- **Session store is file-backed** (`session-file-store`, writing into `data/sessions/`
  alongside `ticks.json`), not express-session's default in-memory store. This was found
  the hard way: the in-memory store is wiped on every process restart (deploys, crashes,
  reboots), which silently logged out every tablet regardless of the 30-day cookie — a
  routine `pm2 restart` shouldn't force a re-login.
- Both layers independently required — belt and braces was explicitly requested, not
  either/or.
- `X-Robots-Tag: noindex, nofollow` header on the Nginx location block. Do NOT list
  `/design` in robots.txt — that would advertise a private path publicly; the header
  achieves the same result without disclosure.
- Socket.IO must share the same session (reject unauthenticated socket handshakes) — the
  realtime channel needs the same gate as the HTTP routes, not a separate/weaker one.

### 13. Database user (least privilege)
Managed DB → user host is `%`, not `localhost`. Grant SELECT only on `orders` (`id`,
`status`, `internal_notes` columns), `items`, `products`, `sanitise`, plus UPDATE on
`orders.status` only. No UPDATE on `items` at all (ticks aren't stored there). No DELETE
anywhere. This user should not be able to read customer names/addresses/phones/emails at
all — column-level grants, not table-level, on `orders`.

### 14. Non-goals / things explicitly rejected during design
- No per-user login accounts (one shared login, name pills for attribution instead).
- No history/undo trail in `ticks.json` itself (§7) — but a separate one-way audit comment
  on tick-ON does exist, see §7a. Don't conflate the two: live state has no history, the
  audit breadcrumb does.
- No cross-order similarity detection (noise).
- No database schema changes of any kind, including small ones (an audit-comments approach
  was considered and explicitly rejected in favour of the file-based tick store).
- No fixed/capped colour palette (rejected, replaced with unbounded hash-to-hue).
- No robots.txt disclosure of the private path.
- **No live-refresh/polling for changes made on the fulfilment side** (e.g. a customer
  cancelling, or editing engraving text, while the order is already showing in the queue).
  Considered and rejected: business policy is that once an order is in any print batch
  (1–4) or beyond, it's deemed already-made — customers can't cancel or change it from that
  point on. That eliminates the staleness risk this app would otherwise need to solve (the
  queue only re-fetches from the DB on local events — a batch move, an issue raised, tab
  switch, or socket reconnect per §11 — never on a timer), without needing polling or push
  infrastructure. If that policy ever changes, this assumption needs revisiting.

---

## Deployment guide

### 1. Database setup
**No schema changes.** The fulfilment database schema is untouched — no new columns, no
new tables. The app only ever runs SELECT against `orders`, `items`, `products` and
`sanitise`, plus one UPDATE to the `orders.status` column when a batch is moved or an
issue is raised — that's the app doing its actual job, not a schema change. Design/verify
tick state and any colour overrides live in small JSON files inside the app's own folder
(`data/ticks.json`, `data/product-colours.json`) — see §7 above. Ticks intentionally have
no audit trail (beyond §7a's order-level breadcrumb) and expire automatically after 3 days.

Dedicated database user (least privilege — pure read access plus the one UPDATE the app is
actually for; cannot read customer names/addresses/phones/emails, cannot delete anything
anywhere). Database is DigitalOcean managed MySQL, so the user host is `%`, not
`localhost`:

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

`internal_notes` (added 2026-08-04, see §7b) lets office staff flag order-specific
instructions that surface as a red warning banner in the queue — read-only, same
column-level-grant pattern as `id`/`status`.

Notes:
- If the DO database has "trusted sources" configured, the droplet is presumably already
  listed (`order_app` connects from it) — no change needed.
- The connection uses TLS (`"ssl": true` in config, already set). For full certificate
  verification, download `ca-certificate.crt` from the DO database dashboard, place it next
  to `config.json`, and add `"caFile": "ca-certificate.crt"` under `db`.

### 2. App setup
Code lives in git — `EngravingStudios/engraving-design-queue` (private), same pattern as
`engraving-automation`/`engraving-orders`: a dedicated deploy key per repo, wired up via an
SSH host alias in the app's OWN `~/.ssh/config` (i.e. `svc-designqueue`'s home, not root's —
see Process ownership above):

```
Host github-design-queue
  HostName github.com
  User git
  IdentityFile ~/.ssh/deploy_engraving_design_queue
  IdentitiesOnly yes
```

On a fresh box, clone it in:
```bash
cd /var/www
git clone github-design-queue:EngravingStudios/engraving-design-queue.git design-queue
cd design-queue
```

Already cloned at `/var/www/design-queue` on this droplet — pull future updates with
`sudo -u svc-designqueue -H bash -lc 'cd /var/www/design-queue && git pull'` instead of
re-cloning. `node_modules/`, `config.json`, and `data/` are gitignored
(local/instance-specific, never committed).

```bash
npm install
mkdir -p data           # holds ticks.json, product-colours.json, and
                         # sessions/ (login sessions — file-backed so
                         # restarts don't log everyone out) — working
                         # state only, safe to wipe if ever needed
cp config.example.json config.json
```

Every value in the template that used to be a `PASTE_` placeholder is now an `@shared:`
reference, so the copied `config.json` needs no local edits (only `auth.username` stays a
plain local value — a username isn't a secret).

Generate the two secrets:
```bash
node hash-password.js 'the-shared-password-you-chose'   # → design_queue.password_hash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # → design_queue.session_secret
```

Add three things to `/etc/orders-app/config.php` — the `design_app` DB password chosen
above, and the two secrets just generated:
```php
'db_design' => [
    'host'     => '<same host as the existing db block>',
    'port'     => 25060,
    'database' => 'fulfilment',
    'username' => 'design_app',
    'password' => '<the password you chose above>',
],
'design_queue' => [
    'password_hash'  => '<output of hash-password.js>',
    'session_secret' => '<output of the randomBytes command>',
],
```

Test run before PM2:
```bash
sudo -u svc-designqueue -H bash -lc 'cd /var/www/design-queue && node server.js'
# should print: Design Queue listening on 127.0.0.1:3050 under /design
```
Then:
```bash
sudo -u svc-designqueue -H bash -lc 'cd /var/www/design-queue && pm2 start server.js --name design-queue && pm2 save'
```
PM2 for this user is kept alive across reboots by the systemd unit `pm2-svc-designqueue`
(enabled via `pm2 startup systemd -u svc-designqueue --hp /home/svc-designqueue`, run once
as root).

### 3. Nginx
Allowlist file — `/etc/nginx/snippets/design-allowlist.conf`:
```nginx
allow 212.139.46.161;  # Workshop fixed IP
allow 217.146.82.84;   # Surfshark VPN static
allow 80.177.191.116;  # Andy home (update as needed)
deny all;
```

Location block — add inside the existing `automation.engravingstudios.co.uk` server block:
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
Then `nginx -t && nginx -s reload`. Do NOT add `/design` to robots.txt — the noindex
header does the job without advertising the path.

### 4. Verification checklist
1. From an allowed IP: `https://automation.engravingstudios.co.uk/design` → login page.
   Wrong password rejected; right password → queue.
2. From a non-allowed IP (e.g. phone on mobile data): connection refused / 403.
3. Header says "Live" (green dot) — WebSocket connected. If it says Offline but the page
   loaded, the Upgrade headers are missing.
4. Open the queue on two devices; tick a box on one → appears on the other within a blink,
   with name + time.
5. Click a plate → paste somewhere → text matches the engraving exactly (including no
   trailing whitespace, per §5's third bug fix).
6. Tick every line in a small batch → Move button turns green → move → toast + tab counts
   update on both devices.
7. Raise a test issue → ticket appears in HelpScout mailbox 240303 → order vanishes from
   the queue (status = pending).
8. Check the logs after first load (`pm2 logs design-queue`) — any product_id=0 items in
   the batch should log a `[unmapped-report]` line and raise one HelpScout ticket
   (in-memory dedup only, no table — restarting the app may re-raise one ticket per name
   still unmapped, which is expected).
9. Set `internal_notes` on a test order and confirm the red banner appears at the top of
   that order's block (§7b); confirm it's absent for orders with no notes.

### 5. Day-2 notes
All `pm2`/log commands below run as the `svc-designqueue` system user, e.g.
`sudo -u svc-designqueue -H pm2 restart design-queue` — not as root.

- Add/remove staff: edit `staff` in `config.json`, `pm2 restart design-queue`.
- Change batch/status names: `statuses` in `config.json`.
- Exclude more groups: `excludedGroupIds` in `config.json`.
- Rotate the shared login password, session secret, or the `design_app` DB password: edit
  the relevant value under `design_queue` or `db_design` in `/etc/orders-app/config.php`,
  then `pm2 restart design-queue`. Never edit `config.json` for these — it only holds
  `@shared:` references, no local secrets.
- Every product gets a permanent colour automatically (hash of its product_id — no setup
  needed). To hand-pick one instead, edit `data/product-colours.json`:
  `{"142": "#5aa9e6"}` — picked up within a minute, no restart needed.
- Tick data lives in `data/ticks.json`. It expires on its own after 3 days — nothing to
  maintain. Safe to delete the file if you ever want to clear all current ticks (e.g.
  testing); the app recreates it.
- Login sessions live in `data/sessions/` (file-backed, survives `pm2 restart
  design-queue` — see §12 above).
- Home IP changed: edit the allowlist snippet, `nginx -s reload`.
- Logs: `pm2 logs design-queue`. Issue-ticket failures appear here — if HelpScout is down,
  the order is NOT moved to pending (deliberate: no order ever parks in pending without a
  ticket behind it).
- Back up `data/` alongside your normal droplet backups if you want belt-and-braces on
  in-flight ticks — not critical (they self-expire and staff can re-tick in seconds), but
  free insurance if you're already snapshotting the box.

---

## Git
Repo pushed to `git@github-design-queue:EngravingStudios/engraving-design-queue.git` via a
deploy key scoped to this repo only (see `~/.ssh/config` host alias `github-design-queue`,
readable by `svc-designqueue` from its own `~/.ssh`, not root's).

**Documentation-first workflow — standing instruction, not per-task:** whenever you make a
change here, update this file with the reasoning behind it — not just what changed, but
why — *before* committing. Then commit and push (as `svc-designqueue`) in the same
session; don't leave documented-but-uncommitted or committed-but-undocumented states
behind for the next session to untangle.
