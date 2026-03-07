# Admin Dashboard

The admin dashboard at `admin.numavm.com` provides platform-wide observability — all users, all VMs, agent sessions, system events, and traffic metrics in one place.

## Access

- **URL**: `https://admin.numavm.com` (production), `http://localhost:4003` (dev)
- **Auth**: Only users with `is_admin=1` in the `users` table can access admin routes. The admin user is seeded on auth service startup for `bilalbakhtahmad@gmail.com`.
- **Auth flow**: Caddy `forward_auth` → auth `/verify` returns `X-User-Admin: true` header → control plane admin routes check it
- **Dev mode**: With `DEV_MODE=true`, set the dev-user as admin in the DB: `UPDATE users SET is_admin = 1 WHERE id = 'dev-user'`

## Architecture

- **Admin API**: `/admin/*` routes in the control plane (`control-plane/routes/admin.ts`) — same DB, same auth mechanism, guarded by `is_admin` check
- **Admin Frontend**: Separate Vite+React app in `admin/` on port 4003 — keeps the user dashboard unbloated
- **Caddy**: `admin.numavm.com` → `forward_auth` (with `X-User-Admin` in `copy_headers`) → `reverse_proxy localhost:4003`
- **Charts**: `recharts` library for VM status distribution bar chart

## Admin API Endpoints

All endpoints require admin access (403 otherwise).

```
GET /admin/stats      Overview: env counts by status, user count, session counts, message count, recent envs, recent events
GET /admin/users      All users with env count, provider type, admin badge
GET /admin/envs       All environments with owner email/name
GET /admin/envs/:id   Detailed env: access list, sessions, message count, live VM status
GET /admin/traffic    TAP RX/TX bytes for all running VMs (reads /sys/class/net/tap-*/statistics/*)
GET /admin/sessions   All agent sessions with env name, message count (limit param, max 500)
GET /admin/events     Recent admin events, filterable by type (limit param, max 500)
GET /admin/health     Extended health: subsystem status + resource utilization (ports used vs total)
```

## Frontend Pages

| Page | Route | Description |
|------|-------|-------------|
| Overview | `/` | Stats cards (users, envs, running VMs, active sessions) + VM status bar chart (recharts) + recent events feed |
| Users | `/users` | Sortable table: email, name, provider badge, GitHub username, env count, join date, admin badge |
| Environments | `/environments` | Sortable table: slug, name, owner, status dot, VM IP, ports (app/ssh/opencode), created date |
| Sessions | `/sessions` | Sortable table: title, env name, agent type badge, status dot, message count, last activity, created |
| Events | `/events` | Filterable event feed with type badges, env links, metadata display, relative timestamps |

## Event Logging

The `admin_events` table tracks VM lifecycle and user activity. Events are emitted via `emitAdminEvent(type, envId, userId, metadata)` from `control-plane/db/client.ts`.

### Event Types

| Type | When | Emitted From |
|------|------|-------------|
| `vm.created` | VM creation succeeds (status → running) | `routes/envs.ts` |
| `vm.deleted` | Env deleted via `DELETE /envs/:id` | `routes/envs.ts` |
| `vm.paused` | Manual pause via `POST /envs/:id/pause` | `routes/envs.ts` |
| `vm.idle_snapshotted` | Idle monitor snapshots a VM | `services/idle-monitor.ts` |
| `vm.woke` | VM restored from snapshot | `services/wake.ts` |
| `agent.session_created` | New agent session started | `routes/agents.ts` |

### Schema

```sql
CREATE TABLE admin_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  env_id     TEXT,
  user_id    TEXT,
  metadata   TEXT,          -- JSON string
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Database Changes

### `users` table — `is_admin` column

- Added via `ALTER TABLE` migration in `auth/db/client.ts` (runs on startup, idempotent)
- `INTEGER DEFAULT 0` — `1` = admin, `0` = regular user
- Seeded: `bilalbakhtahmad@gmail.com` is set to `is_admin = 1` on every auth startup
- Referenced in both `auth/db/client.ts` and `control-plane/db/client.ts` `User` interfaces

### `admin_events` table

- Created via `CREATE TABLE IF NOT EXISTS` in `control-plane/db/schema.sql` (runs on startup)
- Indexes on `type` and `created_at` for fast filtering and sorting

## File Structure

```
admin/
├── package.json          # react, react-dom, react-router-dom, recharts
├── vite.config.ts        # port 4003
├── tsconfig.json
├── index.html            # Geist Mono font, same body classes as dashboard
├── postcss.config.js     # @tailwindcss/postcss
├── .env                  # VITE_API_URL=//api.numavm.com
└── src/
    ├── main.tsx          # StrictMode → ToastProvider → BrowserRouter → App
    ├── App.tsx           # Header + Sidebar + Routes layout
    ├── index.css         # Tailwind theme (same as dashboard)
    ├── vite-env.d.ts     # Vite client types
    ├── lib/
    │   ├── api.ts        # adminApi with typed fetch helpers for /admin/* endpoints
    │   └── time.ts       # relativeTime + formatBytes helpers
    ├── components/
    │   ├── Header.tsx    # "numavm / admin" breadcrumb + link to app dashboard
    │   ├── Sidebar.tsx   # NavLink list: Overview, Users, Environments, Sessions, Events
    │   ├── StatsCard.tsx # Reusable stat card (label, value, subtitle, optional status dot)
    │   ├── DataTable.tsx # Generic sortable table with column definitions
    │   └── Toast.tsx     # Toast notification system (copied from dashboard)
    └── pages/
        ├── Overview.tsx  # Stats cards + recharts BarChart + recent events
        ├── Users.tsx     # DataTable with user columns
        ├── Environments.tsx # DataTable with env columns + status dots
        ├── Sessions.tsx  # DataTable with session columns
        └── Events.tsx    # Filterable event feed with type filter dropdown
```

## Deployment

### systemd service

`infra/systemd/numavm-admin.service` — serves the built `dist/` via `npx serve -s dist -l 4003 --cors`. Auto-restarts on failure.

### deploy.sh

```bash
./deploy.sh                    # Full deploy (builds + restarts dashboard, admin, auth, CP)
./deploy.sh --admin-only       # Only rebuild and restart admin dashboard
./deploy.sh --install-services # One-time: install all systemd units including admin
```

### Environment variables

- `VITE_API_URL` in `admin/.env` — set to `//api.numavm.com` for production, `//localhost:4001` for local dev
- `ADMIN_PORT` in root `.env` — defaults to `4003` if not set (used by Caddy config generation)

## Development

```bash
# Start admin dashboard with hot reload
cd admin && npm run dev

# Build for production
cd admin && npm run build
```

The admin frontend follows the same patterns as the user dashboard:
- `apiFetch<T>()` with `credentials: "include"` for cookie auth
- Tailwind CSS 4 with Geist Mono font
- Local state only (`useState`/`useEffect`), no global store
- Status dots: `w-1.5 h-1.5 rounded-full bg-{color}`
- Links: `text-xs underline underline-offset-4 hover:opacity-60`

## Adding New Admin Features

1. **New API endpoint**: Add route in `control-plane/routes/admin.ts` (inside `registerAdminRoutes`) — admin preHandler hook applies automatically
2. **New event type**: Call `emitAdminEvent("your.event", envId, userId, { metadata })` from the relevant code path
3. **New page**: Create in `admin/src/pages/`, add route in `App.tsx`, add nav link in `Sidebar.tsx`
4. **New stat card**: Use `<StatsCard label="..." value={...} />` in Overview page
