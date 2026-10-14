# API Load Lab — backend

Real pipeline behind the mockup: `target-api` (Postgres + Redis, toggleable cache /
DB index / queue / rate limiter), a `worker` processing queued lookups via BullMQ,
and `control-api` (load generator + WebSocket metrics stream).

## Run it

```bash
docker-compose up --build
```

First boot seeds `products` with 1,000,000 rows (pure SQL, a few seconds).

- `target-api` → http://localhost:3000
- `control-api` → http://localhost:4000

## Try it

```bash
# single lookup
curl http://localhost:3000/products/SKU-0000001

# flip toggles (forwarded to target-api, mirrored into the cost model)
curl -X POST http://localhost:4000/toggles -H "content-type: application/json" \
  -d '{"index": true}'

# start a load profile: constant | ramp | spike | stress | soak
curl -X POST http://localhost:4000/run/start -H "content-type: application/json" \
  -d '{"profile": "spike"}'

curl -X POST http://localhost:4000/run/stop
```

Connect to `ws://localhost:4000/ws` to receive a `snapshot` on connect, then one
`tick` per second: `{ t, rps, err, p50, p95, p99, hitRatio, inFlight, cost, breakdown }`.

## What's real vs. simulated

- Cache, DB index, queue depth, rate limiting, and every latency number are real —
  measured from actual HTTP round trips against Postgres/Redis/BullMQ.
- The `cost` field is a stand-in model (there's no cloud bill to read locally), not
  real billing — same honest framing as the UI mockup.

## Next step

The visual mockup still runs its own local simulation. Wiring its canvas/charts to
this `/ws` stream (instead of the fake generator) is the next increment.
