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

**Before adding any new credential to this app, read the `orders` repo's CLAUDE.md,
"Credentials policy for any new app", first** — this app's own revisited "shared secrets
only" draft above is exactly the failure mode that policy exists to prevent.

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
- **Zero fulfilment database schema changes.** No new columns, no new tables — only new
  grants on existing ones as features need them (§8b added `proofs`/
  `ship_station_carrier_services`). The app only SELECTs from `orders`, `items`, `products`,
  `sanitise`, `proofs`, `ship_station_carrier_services`. The ONE exception:
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
- **Word rules** (purely alphabetic `find`): match **case-insensitively AND on word
  boundaries (`\b...\b`)**, replacement **mirrors the customer's typed casing**
  (`speyed`→`spayed`, `Speyed`→`Spayed`, `SPEYED`→`SPAYED`). This was an explicit design
  decision — do not make word rules case-sensitive. The `\b` boundaries were added
  2026-08-04 (see the `im`→`I'm` fix below) — without them a short `find` like `im` would
  also fire inside `simple`/`trim`/`swim`, silently corrupting unrelated words. Existing
  rules (`speyed`, `microchiped`, ...) are unaffected since they were already meant to
  match whole words.
- **Literal rules** (symbols/entities): exact literal replace, casing is meaningless here.

Applied in `id` order from the table. Normalise `\r\n`/`\r` → `\n` first. Empty string or
literal `"NULL"` after trim → treat as null. This is a single whole-string `.trim()`, not a
per-line trim — see the clipboard-copy note in §7 for why trailing whitespace on internal
lines needs separate handling.

**Two built-in fixes on top of the DB rules (added 2026-08-04), applied in code, not as
`sanitise` table rows** — each needs logic a `find`/`replace` row can't express:

- **UK postcode reformatting** (`lib/sanitise.js`'s `fixPostcodes()`): customers often
  paste postcodes run together (`ts182nh`) or spaced wrong. A regex finds anything shaped
  like a UK postcode — outward code (1-2 letters, a digit, optionally one more
  letter/digit — covers A9, A99, A9A, AA9, AA99, AA9A) then inward code (always digit + 2
  letters) — uppercases both parts and strips whatever whitespace (if any) sits between
  them, reinserting exactly one space: `ts182nh`→`TS18 2NH`, `e15pw`→`E1 5PW` (outward
  `E1`, not `E15` — the inward code must be digit+2-letters, so backtracking correctly
  finds the `E1`/`5PW` split), `E125PW`→`E12 5PW`. The uppercasing is deliberately
  **fixed-case, not mirrored** — postcodes are always shown in capitals regardless of how
  the customer typed them, unlike the word rules below. Not a DB rule because every
  postcode is a different string — the fix is "insert a space at the right position," not
  a fixed string pair. Deliberately just a shape-based heuristic (not full Royal Mail
  validation) — reformats anything postcode-shaped, doesn't attempt to verify the postcode
  is real.
- **`im` → `I'm`** (`fixImContraction()`): customers often skip the apostrophe on "I'm"
  (`im bobbie`). Matched word-boundary-only (`\bim\b`) so it can't fire inside
  `simple`/`trim`/`swim`/`victim`/names like `Kim`/`Tim` — confirmed by test. Casing is
  **mirrored** via the same `matchCase()` every other word rule uses — `im`→`i'm`,
  `Im`→`I'm`, `IM`→`I'M` — confirmed 2026-08-04 as the wanted behaviour (an earlier version
  force-capitalised the `I` always on grammatical grounds; that was explicitly overridden
  — casing should track the source text exactly like `speyed`→`spayed` does, not apply a
  grammar rule on top). Kept as a built-in rather than a `sanitise` table row even though
  the `\b` fix above would now make a DB row safe, because this app's DB user has no
  `INSERT`/`UPDATE` grant on `sanitise` (SELECT only) — a built-in guarantees it's always
  on without needing a separate admin path into that table.
- **Double-space collapsing** (`fixDoubleSpaces()`, added 2026-08-05): a fat-fingered
  spacebar produces an accidental double space between two words, which this collapses to
  one — EXCEPT where the wide spacing is a deliberate design feature, which must survive
  untouched. Two protected patterns, checked per line: (1) **letter-spacing**, e.g.
  `F  R  E  D  D  I  E` — if most of a line's space-separated tokens are single characters,
  the whole line is left alone, on the theory it's a spaced-out word/name, not prose: (2)
  **decorative flanking**, e.g. `-  I'm chipped  -` — a gap is left alone if the token on
  either side of it is pure punctuation/symbols (not alphanumeric), since that reads as a
  border/emphasis mark, not a typo. Everything else collapses. Deliberately NOT extended to
  protect short real-word pairs (e.g. a hypothetical deliberate `HI  MUM`) — that would also
  suppress fixing genuine typos between common short words, which is the far more frequent
  case; the two protected patterns above were chosen because they're the ones actually seen
  in practice and are structurally distinguishable from a typo, not because the heuristic
  is exhaustive.

Three run after the DB rule pass, before the final trim.

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

**Fifth real bug (fixed 2026-08-04)**: the second fix above was too strict — gating
highlighting purely on the 0.65 Levenshtein threshold also suppressed the side that
*didn't* trigger the match even when it was short and genuinely differed, e.g. two lines
with an identical multi-line front but different single-word back (`MONTY` vs `WINSTON`,
same order, front matches so the banner correctly fires). A one-word field's Levenshtein
ratio against a completely different one-word field is low (two totally different words
share few characters), so it fell below threshold and got suppressed — same as the
unrelated-medical-notes case above — leaving the banner saying "differences highlighted"
with nothing actually highlighted anywhere, since the matching side (front) had nothing to
highlight either (it was identical). Fix: `diffWorthy(a,b,ratio)` in `public/index.html`
— a side is worth diff-highlighting if it cleared the threshold (unchanged) **or** if both
texts are short (≤3 words) and not literally equal. For a short field, the whole thing
lighting up in `<mark>` *is* the useful signal ("this one word changed"), unlike a long
field where a low ratio really does mean "unrelated content" and marking nearly everything
is noise — that distinction, not a flat threshold, is what the suppression was meant to
capture.

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

### 8a. Batch A/B split (added 2026-08-05)
When two designers work the same batch, splitting divides the WORK across them without
touching the batch itself — Move still moves everything in one go, same as §8, regardless
of any split. File-based, same rationale as ticks (§7): short-lived working state, not
schema-worthy. Lives in `data/batch-splits.json` via `lib/batchSplits.js`, keyed by status
value → `{ [productGroupName]: "A"|"B" }`.

**UI**: a small split-glyph icon sits inline next to EVERY batch tab's label (not just the
currently active one — confirmed explicitly, so any batch can be split without switching to
it first). Clicking it opens a confirm dialog ("Split Batch 1 into A/B? Each product group
will go in full to one designer…") — Cancel / "Split", reusing the same overlay/modal
pattern as Move's conflict warning. Requires "Working as" first, same as every other
mutating action, purely for UX consistency with tick/move/issue — nothing is attributed to
a name on disk. Once a status is split, that tab's icon disappears (nothing left to
configure) and is replaced by a second row directly under THAT tab's own label — either the
live "All / A / B" filter pills, if it's the tab currently being viewed, or a compact static
"Split A/B" badge if it's a different, not-currently-active split batch — confirmed
explicitly: the pills need to visually read as belonging to their specific tab, not sit off
in a separate control area.

- **Split unit is the product group, not the order or line** — the exact same grouping the
  queue already renders by (an order's first line's product name, `lib/queue.js`'s
  `computeGroupTotals()`). Explicitly requested: keep whole product groups together (e.g.
  ALL 33mm brass discs to one designer) rather than splitting by raw order/qty count, since
  that's what lets someone work a group start-to-finish.
- **Balance algorithm**: largest group first, each dropped into whichever bucket currently
  has the smaller running qty total (the standard "longest processing time" bin-balancing
  heuristic) — not a guaranteed even split, but close for any realistic mix of group sizes;
  confirmed acceptable ("doesn't need to be exact, just roughly the same workload").
- **Locking is permanent, by design** — once a group is assigned A or B it is NEVER
  reassigned by a later recompute, only ever set the first time that name is seen for that
  status. This was explicitly requested: staff work through EngraveLab in the order the
  queue presents, and the verify pass depends on that same order holding — a group flipping
  buckets mid-batch would break that.
- **New orders arriving mid-batch require no action**: every queue fetch lazily assigns any
  not-yet-locked group into whichever bucket's current live total is smaller, and locks it
  immediately (`fillNew()`). Confirmed explicitly — batches aren't reassigned once staff are
  working them, so there's no "manual re-split" control, it just silently keeps up.
- **Filtering only ever hides whole groups, never reorders** — clicking the "A"/"B" pill
  filters `typeOrder` down to matching groups but leaves their relative order exactly as the
  unfiltered queue would show it (tier → qty → order id, §4). This was the critical
  requirement, not an afterthought: EngraveLab work happens in that same sequence for both
  the design AND verify passes, so a filtered view has to reproduce it exactly, not just
  show "the right subset in some order."
- **`splitStatusMap()`** (`lib/queue.js`) returns split-active state for every batch status
  in one call, not just whichever one the client happens to be viewing — needed so a tab
  you're NOT currently on can still show its own icon/badge correctly. Cheap (in-memory
  only, no DB round trip), returned on every `/api/queue` response regardless of which
  status was requested.
- **Progress bars follow the active filter** (so e.g. a designer filtered to "A" sees
  their own half's Designed/Verified %), but the **Move button always reads the full
  unfiltered batch** — moving is status-driven (§8) and happens for everything regardless
  of who's filtered to what, so its readiness can't be scoped to one half. Confirmed
  explicitly: staff want to see progress on their own slice, but Move's green/grey state
  must keep meaning "the whole batch is actually done."
- **Stale-split protection**: a status value like `print_1st_batch` gets reused for a
  completely new set of orders once the old batch is fully moved out. `moveBatch()` clears
  that status's split data the moment the move commits — the normal, expected path. As a
  belt-and-braces fallback (requested explicitly, in case a move happens outside the normal
  flow — crash, manual DB edit), every queue fetch also checks: if NONE of a status's locked
  group names are present in the current queue at all, the whole split is discarded as an
  orphan from a previous cycle. A batch that's simply had some orders move through it during
  the day still has plenty of overlap, so this never fires on ordinary same-day activity —
  only on a full turnover.
- Requires "Working as" first, same as every other mutating action, even though nothing is
  attributed to a name on disk — kept for UX consistency with tick/move/issue, not because
  the split itself needs an audit trail.

### 8b. Batch summary file — material breakdown + packing sheets (added 2026-08-06)
A small document-glyph icon sits inline next to the split icon on EVERY batch tab (1-4
only, same scope as §8a — Label Hold/Pending don't get one), title "Prepare summary file
for this status". Click → plain navigation to `GET /api/summary/:status` (not fetch+blob) —
`Content-Disposition: attachment` lets the browser handle the download natively without
leaving the page. No reliable "download finished" event exists for a plain navigation the
way there is for Move's socket ack, so a toast on click is the honest acknowledgment rather
than a spinner pretending to track real completion.

Zip contains two things, both generated fresh on each click, nothing stored on disk:
- `material-breakdown.txt` — every order in that batch, in exactly ONE of four lists (Brass
  / Aluminium / Mixed / Unknown), based on a case-insensitive substring match for "Brass"/
  "Aluminium" against each line's product title (or raw item name for unmapped items, same
  fallback `queue.js` already uses). Mixed if a title match for BOTH exists anywhere in the
  order, Unknown if neither does — mutually exclusive by design, not per-line tagging, since
  the ask was a shipping-prep list of order NUMBERS.
- `packing-sheets.pdf` — one A4 page per qualifying order via `pdfkit`. An order qualifies if
  EITHER its product titles contain any of Garden/Wall/Plinth/Mount, OR `internal_notes`
  (§7b) contains any of Urgent/Must go/Brushed/No paint/No infill — either alone is
  sufficient, not both. Each page: customer name (`first_name`+`last_name`), shipping method
  (`ship_station_carrier_services.name`, joined via `orders.ship_station_service`), every
  line's item name/qty/engraving, the internal-notes warning if present, and the proof image
  if available.

**Deliberately a SEPARATE query from `queue.js`'s `fetchQueue()`** (`lib/summary.js`), not a
reuse — `fetchQueue()` excludes `group_id=15` (fixings) from the design view (§2), but a
packing sheet needs every physical item going in the box, fixings included. Reusing the
filtered query would silently under-report what's actually being shipped.

**Proof image — fetched live over HTTP, not read from a local path**: `proofs.file` is just
a filename; the actual image lives at a fixed public URL under the fulfilment app
(`proofImageBaseUrl` in config — `https://fulfilment.engravingstudios.co.uk/uploads/orderproofs/{file}`),
not on this droplet's filesystem or in the database. A missing proof row, or a failed fetch
(404/network issue), just omits the image from that one page rather than failing the whole
batch's zip — one order's absent proof shouldn't block everyone else's packing sheets. Each
order has at most one live `proofs` row (`suppress = 0`) — confirmed 1:1 with orders in
practice, so this is a plain `LEFT JOIN`, not a "pick the right one of several" query.

**New DB grants, added 2026-08-06** (see Deployment guide §1) — first genuinely new PII this
app can read, added deliberately and narrowly: `orders.first_name`/`last_name` (customer
name) and `orders.ship_station_service` (an ID, not the readable method — joined against
`ship_station_carrier_services.name` for that), plus full-table `SELECT` on
`ship_station_carrier_services` (a shipping-method lookup table, no customer data in it) and
column-level `SELECT` on `proofs` (`order_id`, `file`, `suppress` — not `customer_notes` or
`internal_notes` on that table, which aren't needed here). Still explicitly NOT
address/phone/email/company — those stay off-limits, same boundary as §13 always had, just
with two more narrow exceptions carved into it for this one feature.

**pdfkit's built-in Helvetica font is WinAnsi-encoded, not full Unicode** — a "⚠" character
in the internal-notes warning silently rendered as a stray "&" glyph instead of failing
loudly. Fixed by using a plain "WARNING -" text prefix instead of the Unicode symbol, rather
than embedding a Unicode-capable TTF font just for one glyph.

**`archiver` v8 dropped the classic `archiver('zip', opts)` factory function for a
class-based API** (`new (require('archiver').ZipArchive)(opts)`) — most existing
docs/examples online (and an earlier draft of this code) assume the old factory shape from
v5-v7, which throws `TypeError: archiver is not a function` on v8. Confirmed against the
installed version's own README, not assumed from memory.

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
- Favicon (added 2026-08-05): `public/favicon.webp` (32×32, Engraving Studios "E" mark),
  referenced with the absolute path `/design/favicon.webp` in both `index.html` and
  `login.html` — an absolute path is required here (not a bare relative `favicon.webp`) for
  the same reason as the Socket.IO script fix above: it must resolve the same regardless of
  whether the page URL has a trailing slash. Same icon applied across every app on this
  droplet (`orders`, `automation`, `mount-stock`) for a consistent brand — see each repo's
  own CLAUDE.md for its specific path.
- Reconnect resync: on Socket.IO reconnect (tablet waking from sleep, wifi blip, server
  restart), refetch the current batch so any missed updates appear — don't rely solely on
  live push for state that may have been missed while disconnected.
- **Tab-switch loading state (added 2026-08-05)**: switching batch tabs needs a real DB
  round trip (§8), which the UI previously gave zero feedback for — the old tab stayed
  highlighted and the old batch's orders stayed on screen until the fetch resolved, making
  the switch feel unresponsive/broken for that gap. `switchStatus()` in `public/index.html`
  now updates `currentStatus` and re-renders the tab bar (so the clicked tab highlights
  immediately) BEFORE the fetch even starts, and shows a spinner in place of the queue
  content while it's in flight. Deliberately NOT applied to background refreshes
  (Socket.IO reconnect, `orders_changed`) — those are near-instant and blanking the screen
  mid-scroll for a live update someone else triggered would be disruptive, not helpful.
  Added a request-sequence guard (`loadSeq`) alongside this: showing the new tab as active
  immediately makes rapid tab-hopping more likely, and without ordering a slower/older
  response landing after a newer one would silently overwrite the display with stale data
  for a tab that's no longer selected — each response now checks it's still the latest
  request before applying itself.
- **Stray vertical scrollbar on `.tabs` (fixed 2026-08-05)**: `.tabs` sets `overflow-x:auto`
  for horizontal scrolling (many tabs on a narrow screen) but never set `overflow-y`. Per
  the CSS spec, when one axis is a non-`visible` overflow value the browser computes the
  other axis to `auto` too if it was `visible` — so `.tabs` silently got `overflow-y:auto`
  as well, and once the §8a split feature made tabs variable-height (a plain single-row tab
  vs. one with a second row of pills/badge), that was enough sub-pixel height difference to
  tip a real, permanently-visible vertical scrollbar into existence, even though nothing
  there ever needs to scroll vertically. Fixed by setting `overflow-y:hidden` explicitly —
  horizontal tab scrolling is unaffected.

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
`status`, `internal_notes`, `first_name`, `last_name`, `ship_station_service` columns),
`items`, `products`, `sanitise`, `ship_station_carrier_services` (full table — a
shipping-method lookup table, no customer data in it), `proofs` (`order_id`, `file`,
`suppress` columns only), plus UPDATE on `orders.status` only. No UPDATE on `items` at all
(ticks aren't stored there). No DELETE anywhere.

**Customer name is now readable (added 2026-08-06, for packing sheets — see §8b)** — the
boundary this app was originally built around was never "zero customer data," it was
"nothing beyond what a specific feature genuinely needs." Still explicitly excluded:
address, phone, email, company — those stay off-limits. Column-level grants, not
table-level, on `orders` — every new PII exception is a deliberate, narrow addition, not a
broadening of the boundary itself.

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
new tables. The app only ever runs SELECT against `orders`, `items`, `products`, `sanitise`,
`proofs`, `ship_station_carrier_services`, plus one UPDATE to the `orders.status` column
when a batch is moved or an issue is raised — that's the app doing its actual job, not a
schema change. Design/verify tick state and any colour overrides live in small JSON files
inside the app's own folder (`data/ticks.json`, `data/product-colours.json`) — see §7 above.
Ticks intentionally have no audit trail (beyond §7a's order-level breadcrumb) and expire
automatically after 3 days.

Dedicated database user (least privilege — pure read access plus the one UPDATE the app is
actually for; cannot read customer address/phone/email/company, cannot delete anything
anywhere). Database is DigitalOcean managed MySQL, so the user host is `%`, not
`localhost`:

```sql
CREATE USER 'design_app'@'%' IDENTIFIED BY 'CHOOSE_A_STRONG_PASSWORD';

GRANT SELECT (id, status, internal_notes,
              first_name, last_name, ship_station_service) ON fulfilment.orders TO 'design_app'@'%';
GRANT UPDATE (status)                     ON fulfilment.orders   TO 'design_app'@'%';
GRANT SELECT                              ON fulfilment.items    TO 'design_app'@'%';
GRANT SELECT                              ON fulfilment.products TO 'design_app'@'%';
GRANT SELECT                              ON fulfilment.sanitise TO 'design_app'@'%';
GRANT INSERT                              ON fulfilment.notes    TO 'design_app'@'%';
GRANT SELECT (order_id, file, suppress)   ON fulfilment.proofs   TO 'design_app'@'%';
GRANT SELECT                              ON fulfilment.ship_station_carrier_services TO 'design_app'@'%';

FLUSH PRIVILEGES;
```

`internal_notes` (added 2026-08-04, see §7b) lets office staff flag order-specific
instructions that surface as a red warning banner in the queue — read-only, same
column-level-grant pattern as `id`/`status`. `first_name`/`last_name`/
`ship_station_service`, plus `proofs` and `ship_station_carrier_services`, were added
2026-08-06 for the packing-sheet feature (§8b) — the first genuinely new customer PII this
app can read, added narrowly and deliberately; address/phone/email/company are still
off-limits.

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
mkdir -p data           # holds ticks.json, product-colours.json,
                         # batch-splits.json (§8a), and sessions/
                         # (login sessions — file-backed so restarts
                         # don't log everyone out) — working state
                         # only, safe to wipe if ever needed
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
- A/B split data lives in `data/batch-splits.json` (§8a). Clears itself automatically when
  a batch is moved, plus self-heals if a status's stored split no longer overlaps with
  what's actually in it — nothing to maintain. Safe to delete if you ever want to clear
  every active split; the app recreates it.
- Login sessions live in `data/sessions/` (file-backed, survives `pm2 restart
  design-queue` — see §12 above).
- Home IP changed: edit the allowlist snippet, `nginx -s reload`.
- Logs: `pm2 logs design-queue`. Issue-ticket failures appear here — if HelpScout is down,
  the order is NOT moved to pending (deliberate: no order ever parks in pending without a
  ticket behind it).
- Summary-file zip (§8b) generates fresh on every click — nothing stored, nothing to clean
  up. If a packing sheet is missing its proof image, check the logs for
  `[packing-sheet] proof image fetch failed` — that order's sheet still generates, just
  without the image (deliberate, see §8b), so this is informational, not a failure to chase.
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
