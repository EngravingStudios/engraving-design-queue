# design-queue — project context for Claude Code

## What this is
Node/Express + Socket.IO app, "ES Design Queue" — a live multi-screen workshop display
at `automation.engravingstudios.co.uk/design/` where staff work through batches of
engraving orders, tick designed/verified per line, and everything updates instantly across
tablets. Full behavioral spec (data model, sort rules, similarity detection, audit trail,
auth) lives in `SPEC.md` — read that before changing any queue logic, it documents the
*why* behind a lot of non-obvious decisions and past bugs. Deployment runbook (DB grants,
PM2, Nginx) lives in `DEPLOY.md`.

## Credentials
All secrets live in `/etc/orders-app/config.php` (outside this folder, shared with the
`orders` PHP app and the `automation`/`mount-stock` Node apps — never move it in here or
commit it). Read via `php -r 'echo json_encode(require $argv[1]);'` at startup
(`lib/config.js`-equivalent loader referenced in `config.json` via `@shared:` keys) — see
`SPEC.md` §13 and `DEPLOY.md` for the exact mechanism. This app's own DB user is
`design_app`, scoped to column-level `SELECT`/`UPDATE` grants on `orders` (see `DEPLOY.md`
§1 for the exact grant list, including `internal_notes` added 2026-08-04) — never a
broader-permissioned credential.

## Process ownership (as of 2026-08-04)
PM2 runs this app as a dedicated system user, `svc-designqueue` — **not root**. Managed by
systemd unit `pm2-svc-designqueue` (PM2_HOME=`/home/svc-designqueue/.pm2`); use
`sudo -u svc-designqueue -H pm2 ...` for any manual PM2 operations, and
`sudo -u svc-designqueue -H bash -lc '...'` for anything else that needs to run as the
app's own user (e.g. `git pull`/`npm install` — `/var/www/design-queue` including `.git`
and `data/` is owned by `svc-designqueue`, not root).

`svc-designqueue` is a member of the `orders-secrets` group, which is what grants read
access to `/etc/orders-app/config.php` (`root:orders-secrets`, mode `640`) — group
membership, not ownership. See the `orders` repo's CLAUDE.md for the full permission model
shared across every app on this droplet, including the recovery checklist for the
"editing config.php resets its group" gotcha.

**Important PM2 gotcha:** a plain `pm2 restart design-queue` forks from the
already-running daemon and will NOT pick up newly-added group membership (e.g. after
`usermod -aG`) — that needs a full `sudo -u svc-designqueue -H pm2 kill` followed by a
fresh `pm2 start`.

## Git
Repo pushed to `git@github-design-queue:EngravingStudios/engraving-design-queue.git` via a
deploy key scoped to this repo only (see `~/.ssh/config` host alias `github-design-queue`,
readable by `svc-designqueue` from its own `~/.ssh`, not root's).

**Documentation-first workflow — standing instruction, not per-task:** whenever you make a
change here, update the relevant doc (`SPEC.md` for behavior/logic changes, `DEPLOY.md` for
deployment/infra changes, this file for anything a fresh session needs to know up front)
with the reasoning behind it — not just what changed, but why — *before* committing. Then
commit and push (as `svc-designqueue`) in the same session; don't leave
documented-but-uncommitted or committed-but-undocumented states behind for the next
session to untangle.
