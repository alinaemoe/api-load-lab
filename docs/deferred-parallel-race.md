# Deferred: live parallel race (A vs B side by side)

Status: **not started, deferred.** The shipped race-mode is sequential
(record run A, replay it as a "ghost" under live run B). This note captures what a
true parallel race would take, so it can be picked up later.

## Why it was deferred

The current stack shares state between anything that runs on it:

- **Postgres**: the DB-index toggle runs `CREATE/DROP INDEX` on the single
  `products` table, so "A with index, B without" cannot coexist.
- **Redis**: cache keys (`product:<sku>`) and the BullMQ `lookup` queue are shared,
  so A's traffic warms B's cache and A's backlog starves B's workers.
- **Fairness**: both runs would compete for the same CPU/disk and one load
  generator, so A's load skews B's numbers.

## What it would take

1. **Second data plane**
   - `products_b` table (or a second database) seeded like `products`;
     `target-api` gets a `TABLE_NAME` / `DATABASE_URL` env so each instance owns its
     index.
   - Separate Redis logical DB (`redis://redis:6379/1`) or a second Redis container,
     plus a distinct BullMQ queue name per side.
2. **Second app plane** in `docker-compose.yml`: `target-api-b` (port 3001),
   `worker-b`. Same image, different env.
3. **`LoadEngine` per side**: make `control-api` hold two engines (`A`, `B`) with
   their own `targetUrl` and toggles; start them on the same tick so profiles line
   up. Add `side: "a" | "b"` to `tick`/`event` messages.
4. **UI**: two pipeline canvases (or one split canvas) and two sets of toggles;
   charts plot both series live. Reuse the ghost/delta rendering from the
   sequential mode.
5. **Fairness controls**: cap per-side concurrency, optionally pin CPU limits in
   compose (`cpus: 1.0` per app container) and show a note that both sides share
   the host.

## Costs and risks

- Roughly doubles RAM/CPU during a race; 1M rows duplicated (~a few hundred MB).
- Numbers are only comparable relative to each other, never absolute.
- Seeding time for the second table on first boot.

## Suggested order when revisited

1. Parametrise `target-api` (table, Redis DB, queue name).
2. Add the B services to compose behind a `race` profile
   (`docker compose --profile race up`).
3. Two engines in `control-api`, then the UI.
