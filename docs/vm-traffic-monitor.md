# VM Traffic Monitor

Per-VM network traffic tracking with historical storage, time-series API, and admin dashboard visualization.

## How It Works

The idle monitor (`control-plane/services/idle-monitor.ts`) already polls TAP device counters every 30s for idle detection. The traffic monitor piggybacks on this loop:

1. Every poll (~30 seconds), reads `/sys/class/net/tap-{slug}/statistics/{rx,tx}_bytes` for each running VM
2. Computes the **delta** (bytes transferred since last recording) — not cumulative totals
3. Inserts a row into `vm_traffic` with the RX/TX deltas
4. Auto-prunes records older than 7 days (checked once per day)

Only non-zero deltas are recorded to avoid filling the DB with idle rows.

## Database

### `vm_traffic` table

```sql
CREATE TABLE vm_traffic (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  env_id      TEXT NOT NULL,
  rx_bytes    INTEGER NOT NULL,    -- bytes received in this interval
  tx_bytes    INTEGER NOT NULL,    -- bytes transmitted in this interval
  recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

Indexes on `env_id` and `recorded_at` for fast per-VM and time-range queries.

### Helper functions (`control-plane/db/client.ts`)

- `insertTrafficRecord(envId, rxBytes, txBytes)` — insert a delta record
- `getTrafficHistory(envId, hours)` — time-series for a specific VM
- `getTrafficSummary(hours)` — totals per VM over a time window, sorted by most traffic
- `pruneOldTraffic(days)` — delete records older than N days (default 7)

## API Endpoints

Both require admin access.

```
GET /admin/traffic/summary?hours=24     Per-VM totals (total_rx, total_tx, samples) over time window
GET /admin/traffic/:id/history?hours=24 Time-series of (rx_bytes, tx_bytes, recorded_at) for one VM
```

`hours` parameter caps at 168 (7 days, matching the prune window).

## Admin Dashboard — Traffic Page

Route: `/traffic` in the admin dashboard at `admin.numavm.com`.

- **Time range selector** — 1h, 6h, 12h, 24h, 2d, 7d buttons
- **Per-VM cards** — shows env slug, RX total (blue), TX total (green), combined total
- **Expandable charts** — click a VM card to expand a stacked area chart (recharts `AreaChart`) showing RX/TX over time
- Data auto-refreshes when the time range changes

## Files Changed

| File | Change |
|------|--------|
| `control-plane/db/schema.sql` | Added `vm_traffic` table + indexes |
| `control-plane/db/client.ts` | Added `insertTrafficRecord`, `getTrafficHistory`, `getTrafficSummary`, `pruneOldTraffic` |
| `control-plane/services/idle-monitor.ts` | Added traffic recording every 10 polls (~5min) + daily prune |
| `control-plane/routes/admin.ts` | Added `GET /admin/traffic/summary` and `GET /admin/traffic/:id/history` |
| `admin/src/lib/api.ts` | Added `TrafficSummary`, `TrafficPoint` types + API methods |
| `admin/src/pages/Traffic.tsx` | New page with summary cards + expandable area charts |
| `admin/src/App.tsx` | Added `/traffic` route |
| `admin/src/components/Sidebar.tsx` | Added Traffic nav link |

## Design Decisions

- **30-second intervals** — high granularity for real-time visibility. At 10 running VMs, that's ~28,800 rows/day, ~201,600/week.
- **Deltas, not cumulative** — TAP counters reset when VMs are snapshotted/restored. Storing deltas avoids negative values and makes SUM queries trivial.
- **7-day retention** — keeps the DB lean. Old data is pruned once per day during the idle monitor poll.
- **Piggyback on idle monitor** — no new timers or processes. The idle monitor already runs on production and already reads TAP stats.
- **Only records when running** — snapshotted/stopped VMs have no TAP device, so no rows are generated for them.
