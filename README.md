# Marketing OS

An AI-powered, multi-tenant marketing management platform. One agency workspace,
many clients, each with its own Brand DNA, campaigns, content, approvals,
analytics and a branded client portal.

```
CLIENT → BRAND DNA → MEDIA → AI CONTENT → CAMPAIGN → APPROVAL
      → SCHEDULING → PUBLISHING → MONITORING → ANALYTICS → AI ANALYSIS → REPORT
```

## Stack

| Layer | Choice |
| --- | --- |
| Frontend | React 18, Vite 6, TypeScript, Tailwind CSS, React Router 7, Recharts, Framer Motion |
| Backend | Node 20.9+ (verified on 22.x), Express 4, TypeScript (ESM) |
| Database | PostgreSQL 16 via Prisma 6 |
| Validation | Zod, on every request body, query and path parameter |
| Auth | Opaque session tokens in HTTP-only cookies, Argon2id password hashing |
| AI | OpenAI through a backend service, with a built-in generator as fallback |
| Storage | Provider interface with a local-disk driver |

No Docker required. In production a **single Node process** serves both the API
and the built SPA, which is what makes this deployable to a Hostinger Node.js
app without a reverse proxy in front of two services.

## Quick start

```bash
npm install                   # also generates the Prisma Client
cp .env.example .env          # local development only; fill in DATABASE_URL and SESSION_SECRET
npx prisma migrate deploy
npm run db:seed               # optional: demo agency with four clients
npm run build
npm start                     # http://localhost:3000
```

In production there is no `.env` step — the host injects the environment. See
[Deploying to Hostinger](#deploying-to-hostinger).

For development with hot reload on both sides:

```bash
npm run dev                   # API on :3000, Vite on :5173
```

### Demo accounts

`npm run db:seed` creates one agency ("Northwind Collective") with four clients
across different verticals — a restaurant, a hotel, a retail store and a
D2C e-commerce brand — with 90 days of analytics. Password for all:
`Passw0rd!demo`

| Role | Email |
| --- | --- |
| Super Admin | `root@marketingos.example.com` |
| Agency Admin | `admin@northwind.example.com` |
| Agency Staff | `staff@northwind.example.com` |
| Client Admin | `owner@zaytoun.example.com` |
| Client User | `team@zaytoun.example.com` |

Other client portals: `owner@cedar-shore.example.com`,
`owner@atlas-outfitters.example.com`, `owner@lumen-skincare.example.com`.

## What is real, and what is not

Stated plainly, because "looks finished" and "is finished" are different things.

### Fully working against the database

Authentication and sessions · role-based access · tenant isolation · client CRUD
· Brand DNA · logo upload with colour extraction · palette approval · media
library · campaign CRUD · content CRUD · AI content generation · hashtag
generation · Arabic and English · content calendar with rescheduling · approval
workflow · notifications · analytics · report generation and export · client
portal · subscription plans and usage limits · Super Admin · audit log.

### Deliberately not pretending

- **Ad-platform integrations are architecture only.** Meta, TikTok, Snapchat,
  Google Ads, Google Business, LinkedIn and X each have an adapter behind a
  shared interface, with real routes, credential storage, connection status and
  UI. Every adapter currently returns **HTTP 501** naming the environment
  variables it needs. Nothing reports a connection that does not exist, and no
  metric is ever invented from a platform we are not connected to.
- **Publishing is not wired up.** Scheduling writes a calendar entry and sets
  status; it does not post to any network.
- **No payment provider.** Plans, subscriptions and limits are enforced by the
  application, but nothing has been charged and no card details are stored. The
  `Subscription` model carries a `providerRef` field for a provider to populate.
- **Analytics data is seeded, not fetched.** `AnalyticsSnapshot` rows come from
  the seed script. Every number in the UI is computed from those rows — none is
  hard-coded — but they describe a fictional company until a real integration
  fills the table.
- **Password reset issues a token but sends no email.** Outside production the
  token is returned in the response so the flow is testable; in production it is
  created and logged for the operator. Wire up a mail transport before relying on it.
- **AI falls back when no key is set.** Without `OPENAI_API_KEY` the built-in
  template engine writes the copy, and the UI labels it "Built-in engine" on
  every result. Set the key and the same endpoints call the model instead.

## Architecture

```
prisma/schema.prisma     25 models, the tenancy boundary is Organization → Client
server/src/
  env.ts                 Zod-validated config; refuses to boot on a bad one
  app.ts                 Express assembly (helmet, CORS, CSRF, rate limits, SPA)
  lib/scope.ts           ← the single place tenant access is decided
  middleware/            auth, validation, uploads, error handling
  services/
    ai/                  bounded context → provider → schema validation
    analytics.ts         every figure in the product is computed here
    palette.ts           logo colour extraction, WCAG contrast
    storage/             provider interface + local disk driver
    integrations/        one adapter per ad platform
  routes/                one router per resource
web/src/
  lib/                   api client, auth, theme, i18n, formatting
  components/            design system, charts, domain components, app shell
  routes/                pages for the agency, client portal and admin
```

### Tenant isolation

`Organization` is the tenant. Every tenant-owned row carries `organizationId`;
rows a client may see also carry `clientId`.

`server/src/lib/scope.ts` derives the access scope **only from the authenticated
session** — never from a body field, query parameter or header. A client user is
pinned to their own `clientId`, so naming another client's id returns 404 rather
than 403: the API does not confirm that the other record exists.

`SUPER_ADMIN` is scoped like an agency admin on the normal API. Cross-tenant
reach is granted only by `crossTenant()`, which only `/api/admin/*` calls.

### AI architecture

```
request → brand context assembled by the caller → AI service → provider
        → zod schema validation → forbidden-word scrub → result → user edits → save
```

The AI service has no database access and no Prisma client. It receives a plain
`BrandContext` object and returns validated structure. It cannot write records:
generation is a pure read, and the user saves the result through the normal
content endpoints after editing it.

For campaign analysis the model receives only figures already computed from
`AnalyticsSnapshot` rows, and the system prompt forbids stating any number not
present in that object. The fallback analyst is rule-based and quotes only the
figures it was handed. Output is labelled as recommendations everywhere it appears.

## API

| Prefix | Purpose |
| --- | --- |
| `/api/auth` | register, login, logout, me, change password, forgot/reset |
| `/api/users` | agency user management |
| `/api/clients` | client CRUD and per-client overview |
| `/api/brands` | Brand DNA, logo upload, palette suggest/approve |
| `/api/media` | upload, browse, retag, delete, storage usage |
| `/api/campaigns` | campaign CRUD, platform mix, per-campaign analytics |
| `/api/content` | content CRUD, AI generation, hashtags, submit, schedule |
| `/api/calendar` | month/week/day views, drag-to-reschedule |
| `/api/approvals` | review queue, decisions, comments |
| `/api/analytics` | dashboard, series, AI marketing analyst |
| `/api/reports` | generate, read, export as HTML or Markdown |
| `/api/notifications` | list, mark read |
| `/api/integrations` | adapter catalogue, connect, disconnect, sync |
| `/api/subscriptions` | plans, subscriptions, usage against limits |
| `/api/admin` | Super Admin only, the only cross-tenant surface |

## Routes

**Agency** `/app/dashboard` `/app/clients` `/app/clients/:id` `/app/brand`
`/app/media` `/app/content` `/app/content/:id` `/app/studio` `/app/campaigns`
`/app/campaigns/:id` `/app/calendar` `/app/analytics` `/app/reports`
`/app/reports/:id` `/app/approvals` `/app/notifications` `/app/integrations`
`/app/settings`

**Client portal** `/client/dashboard` `/client/campaigns` `/client/content`
`/client/approvals` `/client/calendar` `/client/analytics` `/client/reports`
`/client/brand`

**Super Admin** `/admin/dashboard` `/admin/clients` `/admin/users`
`/admin/plans` `/admin/subscriptions` `/admin/reports` `/admin/audit`
`/admin/settings`

**Public** `/login` `/register` `/forgot-password`

## Security

- Argon2id password hashing at OWASP-recommended parameters.
- Opaque 256-bit session tokens; only their SHA-256 hash is stored, so a database
  leak does not hand over live sessions.
- HTTP-only, SameSite=Lax cookies; `Secure` in production.
- Double-submit CSRF on every authenticated mutation.
- Rate limiting globally and tighter on credential endpoints.
- Zod validation on every input; tenant ids never taken from the client.
- Upload validation by MIME **and** magic number. SVG is rejected outright — it
  is an executable document and would be stored XSS.
- Uploads served with `nosniff` and a restrictive CSP.
- Helmet security headers, with a full CSP in production.
- Integration credentials are never included in any API projection.
- Deactivating a user or suspending a client deletes their sessions immediately.
- No secrets in the repository; `.env` is git-ignored and `.env.example` documents
  every variable.

## Internationalization

Arabic and English, with full RTL. The language switcher flips `dir` on `<html>`
immediately — no reload — and the choice is persisted. Layout uses logical
properties (`ms-`, `me-`, `start-`, `end-`) so it mirrors correctly. Numeric spans
are marked `dir="ltr"` so signs and currency symbols stay on the correct side.

Content is generated independently in either language: the AI writes native
Arabic marketing copy, not a translation of the English.

**Known gap:** notification and alert text generated server-side is English only.

## Theming

Dark, light and system, defaulting to premium dark. All colour is CSS custom
properties, so an approved client palette re-skins the entire application at
runtime — a client signing into their portal sees it in their own brand colours.

## Testing

```bash
npm run typecheck    # server + web
npm test             # 86 server tests against a real PostgreSQL database
npm run build        # production build of both
npm run verify       # all three
```

The tests run against real PostgreSQL, not a mock — a mocked Prisma client would
prove nothing about whether the queries are actually scoped. Coverage includes
authentication and sessions, CSRF, password reset single-use, role authorization,
**tenant isolation** (including cross-tenant access attempts by id), client and
campaign CRUD, the approval workflow, scheduling rules, calendar rescheduling,
report generation and export, analytics maths at the boundaries, AI generation
including forbidden-word scrubbing and Arabic output, upload validation
including a file that lies about its MIME type, and the integration adapters'
refusal to fake a connection.

Set `TEST_DATABASE_URL` to point the suite at a different database; it defaults
to `marketing_os_test`.

## Deploying to Hostinger

Target architecture — one Node process, no separate frontend host:

```
Browser → Hostinger Node.js App → single Node process ┬─ Express API
                                                      └─ React build (web/dist)
                                                             ↓
                                                       PostgreSQL
```

### Exact settings

| Hostinger field | Value |
| --- | --- |
| Application root | the repository root (the directory holding `package.json`) |
| Node.js version | **22.x** (verified). Minimum supported is 20.9.0 |
| Package manager | npm |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Application startup file | `server/dist/index.js` |
| Application mode | production |

`npm start` runs `node server/dist/index.js`. If the panel asks for a startup
file rather than a command, give it `server/dist/index.js` — they are the same
thing.

**Do not set `PORT`.** Hostinger injects it and the app binds `0.0.0.0` on
whatever it is given. Setting it yourself is a common cause of a process that
starts but never receives traffic.

**Build needs devDependencies.** TypeScript and Vite are devDependencies, so the
build command must be plain `npm install` — not `npm ci --omit=dev` or
`npm install --production`. If you prefer `npm ci`, use `npm ci && npm run build`.

**Node 22, not 20.** Both work — `engines` allows anything from 20.9.0 up, and
nothing in the code needs 22. Choose 22 because it is the version the build and
the full test suite are actually run against here, and because Node 20 leaves
maintenance support in 2026; picking it now only schedules another migration.
Pick 20 only if the hosting plan does not offer 22.

### 1. Prepare the database

hPanel → Databases → PostgreSQL. Create a database and note host, port, name,
user and password. Any hosted PostgreSQL works — Hostinger's own, Supabase,
Neon, or an external server.

### 2. Create the Node.js app

hPanel → Advanced → Node.js → Create application, using the table above.

### 3. Set environment variables

In the app's Environment variables panel. Only two are required:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?schema=public
SESSION_SECRET=<48 random characters>
```

Generate the secret locally and paste the result:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Strongly recommended as well:

```
NODE_ENV=production
APP_URL=https://your-domain.com
TRUST_PROXY=1
STORAGE_LOCAL_DIR=./storage/uploads
```

Everything else has a working default — see `.env.example`. **The application
never reads a `.env` file in production;** it reads `process.env` directly, so
there is nothing to upload and no `cp .env.example .env` step.

Two more matter only on constrained shared hosting, where the query engine
panics if it cannot spawn a thread:

```
DATABASE_CONNECTION_LIMIT=5   # default; lower to 3 if the engine panics
UV_THREADPOOL_SIZE=2          # optional, saves two more threads
```

See [the process/thread
ceiling](#panic-timer-has-gone-away--the-processthread-ceiling) for what these
actually do and when to reach for them.

### 4. Deploy from GitHub

Connect the repository and deploy the branch. Hostinger runs the build command,
then the start command.

### 5. Apply migrations

Once, from the panel's terminal, and again after any deployment that changes the
schema:

```bash
npx prisma migrate deploy
```

Use `migrate deploy` — never `migrate dev` and never `migrate reset` — on a live
database. To load the demo agency (skip for a real deployment):

```bash
npm run db:seed
```

### 6. Domain and SSL

Point the domain at the app and enable SSL in hPanel. Once HTTPS is live, leave
`COOKIE_SECURE` unset — it defaults to on in production. Only set it to `false`
if the site is genuinely served over plain HTTP, and the startup log will warn
you that it is off.

### 7. Verify

```
https://your-domain.com/api/health   →  {"status":"ok","database":"ok","engine":"ok","uptime":N}
https://your-domain.com/login        →  the sign-in page
```

Then check the runtime log. A healthy boot prints:

```
[marketing-os] started
  environment    production
  node           v22.x.x
  listening      0.0.0.0:<port>
  front end      served from web/dist
  secure cookies on
  database       checking in the background…
[marketing-os] database connected
```

The last line arrives a moment after the rest, and that ordering is deliberate:
the server binds its port first and checks the database afterwards. See
[Startup order](#startup-order-and-the-3-second-rule) for why.

If any of those lines is missing or says something else, the troubleshooting
table below names the cause.

### Startup order, and the 3-second rule

Hostinger kills a Node process that has not called `listen()` within about three
seconds of starting. That makes any `await` in front of `listen()` a deployment
hazard, and a database ping the worst kind: an unreachable database stops being
a degraded feature and becomes an unrecoverable boot loop, which the browser
only ever shows as a 504.

So the entry point does exactly three things, in this order:

1. validate configuration — synchronous, no network
2. `app.listen()` — nothing is allowed to run before this
3. everything else, in the background

The database is probed from inside the `listen` callback. If it is unreachable
the app still starts and still serves pages; `/api/health` reports
`{"status":"degraded"}` with HTTP 503, the runtime log prints the full
diagnostic, and a background watcher re-checks every 60 seconds so the app
recovers on its own once the database comes back. Nothing is hidden — routes
that need the database still fail loudly and individually.

There is deliberately no `if (require.main === module)` guard around `listen()`:
the server starts as soon as `server/dist/index.js` is loaded, however the host
chooses to load it.

### Notes for production

- `STORAGE_LOCAL_DIR` must be on persistent storage and outside the web root.
  Uploads are served through the app, never directly by the web server. If the
  plan's filesystem is ephemeral, uploaded media will not survive a redeploy —
  add a remote driver in `server/src/services/storage/` before relying on it.
- `TRUST_PROXY=1` is required behind Hostinger's proxy. It is what makes client
  IPs, rate limiting and HTTPS detection correct. Do not raise it above the real
  number of proxy hops.
- Back up the database before any deployment carrying a migration.

### Hosted PostgreSQL (Supabase, Neon, and similar)

Most hosted providers require TLS. Append `sslmode=require`:

```
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME?schema=public&sslmode=require
```

Supabase specifically:

- **Session pooler / direct (port 5432)** — use this. Works with Prisma as-is.
- **Transaction pooler (port 6543)** — add `&pgbouncer=true&connection_limit=1`,
  and run `prisma migrate deploy` against the port-5432 URL, because migrations
  need a session-mode connection.
- If the host has no IPv6 route, use Supabase's IPv4 add-on or the session
  pooler hostname.

No Supabase SDK is involved — it is simply the PostgreSQL provider.

### The Prisma query engine on Hostinger

Prisma ships a native query engine, and it must match the OpenSSL version of the
machine that *runs* the app — not the one that built it. Hostinger's Node
runtime reports:

```
Distro is "undefined" ... Found libssl.so file using "ldconfig": libssl.so.1.1
The parsed libssl version is: 1.1.x
```

so at runtime it loads `libquery_engine-debian-openssl-1.1.x.so.node`. Left at
the default (`native`), `prisma generate` emits only the engine for the build
machine — commonly openssl **3.0.x** on a current image — and the 1.1.x file is
simply absent. The client then fails to start, which surfaces as
`PrismaClientRustPanicError` / `PANIC: timer has gone away`, because the panic
happens while the engine library is being started rather than while connecting.

`prisma/schema.prisma` therefore requests both explicitly:

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "debian-openssl-1.1.x"]
}
```

Both are emitted by the `postinstall` hook, so a normal `npm install` on the
host produces the right engine with no extra step. Verify after a build:

```
ls node_modules/.prisma/client/ | grep libquery_engine
# libquery_engine-debian-openssl-1.1.x.so.node
# libquery_engine-debian-openssl-3.0.x.so.node   ← or whatever `native` resolved to
```

### `PANIC: timer has gone away` — the process/thread ceiling

If the engine file above is present and being loaded (the log shows
`resolveEnginePath …libquery_engine-debian-openssl-1.1.x.so.node` followed by
`library starting`) and it *still* panics, the cause is not the engine build.
It is the host's process allowance.

The panic comes from `futures-timer`, in the engine's attempt to spawn its timer
thread. When that spawn fails the engine panics — so the real message is "this
account has no thread budget left". Shared hosting counts threads towards the
process limit, and three pools in one Node process all size themselves from the
**CPU count the host reports**, which is the whole machine's, not your slice:

| Pool | Default size | Lever |
| --- | --- | --- |
| V8 workers | CPUs − 1 | `--v8-pool-size`, already set to 2 in `npm start` |
| Prisma connection pool | CPUs × 2 + 1 | `DATABASE_CONNECTION_LIMIT`, default 5 |
| libuv | 4 | `UV_THREADPOOL_SIZE` (also used by password hashing) |

Measured locally on a 4-CPU machine: 9 threads at startup, **15 once the query
engine is running**. On a 32-core host the same process would want far more.

The startup log prints the numbers that decide it, so this is checkable rather
than guesswork:

```
  cpus visible   4  (v8 pool, prisma workers and its default pool all scale from this)
  threads now    9
  max processes  soft 64262 / hard 64262  (counts threads too)
[marketing-os] database connected (process threads: 15)
```

**In order:**

1. **Restart the app from hPanel.** Old deployment versions left running are the
   usual cause — each one holds its own threads, and they accumulate across
   deploys until the ceiling is hit.
2. **Lower `DATABASE_CONNECTION_LIMIT`** (try 3). The default of 5 is already far
   below Prisma's own default.
3. **Add `UV_THREADPOOL_SIZE=2`** to the Environment variables panel for two more
   threads. Password hashing shares this pool, so do not go below 2.
4. **Switch to the binary engine**, which runs the engine in its own process
   rather than as a library inside Node:
   - Add `PRISMA_CLIENT_ENGINE_TYPE=binary` to the Environment variables panel.
   - Redeploy, so `npm install` — and therefore `prisma generate` — runs **with
     the variable already set**. The engine type is baked into the generated
     client; setting it only at runtime is silently ignored and changes nothing.
     Locally the same switch is `npm run prisma:generate:binary`.

A panic poisons the client instance permanently, so the app **replaces the
client automatically** and keeps serving — a transient exhaustion recovers
without a manual restart. `/api/health` reports `engineRecoveries`; a number
that keeps climbing means the ceiling is genuinely too low and step 1–4 above
have not gone far enough.

## Troubleshooting

### 503 Service Unavailable

The process is not running. A build that succeeded says nothing about this —
**read the runtime log**, which will contain one of these:

| Log says | Cause | Fix |
| --- | --- | --- |
| `FAILED TO START — invalid environment configuration` | `DATABASE_URL` or `SESSION_SECRET` is not set | Add it in the Environment variables panel and restart |
| `FAILED TO START — port already in use` | `PORT` was set manually | Remove it and let Hostinger inject it |
| `App did not call listen() within 3 seconds` | Something is blocking startup before the port is bound | Nothing in this app awaits before `listen()` — see [Startup order](#startup-order-and-the-3-second-rule). If you added a check to `server/src/index.ts`, move it into the `listen` callback |
| `FAILED TO START — upload directory is not writable` | `STORAGE_LOCAL_DIR` points somewhere read-only | Point it at a writable persistent path |
| `Cannot find module '/…/server/dist/index.js'` | The build did not run | Build command must be `npm install && npm run build` |
| `@prisma/client did not initialize yet` | Prisma Client was not generated | `npm install` runs `prisma generate` via postinstall; re-run the build |
| `PANIC: timer has gone away`, `PrismaClientRustPanicError` | The query engine could not spawn a thread — the account's process/thread ceiling is exhausted | See [the process/thread ceiling](#panic-timer-has-gone-away--the-processthread-ceiling) |
| Nothing at all | Wrong startup file | It is `server/dist/index.js`, not `server.js` or `index.js` |

Note that a database fault no longer produces a 503 from the *host*: the app
starts regardless, serves pages, and reports the fault itself.

### `/api/health` returns `{"status":"degraded"}` with HTTP 503

The process is healthy; the database is not. This is the honest answer rather
than a failure to boot, and pages still render. The runtime log carries the full
diagnostic and names which of the two cases applies:

- **`DATABASE UNREACHABLE`** with a driver error such as *Can't reach database
  server at …* — credentials, host, firewall or missing SSL. Add
  `?sslmode=require` for a hosted provider.
- **The same banner naming an engine panic** — the query engine never got as far
  as connecting. See [the process/thread
  ceiling](#panic-timer-has-gone-away--the-processthread-ceiling);
  `"engine":"panicked"` in the health response says the same thing, and
  `engineRecoveries` counts how often the client has had to be replaced.

The connection string is never written to the log — it contains a password.

### Pages 404 but `/api/health` works

The front end was not built. The startup log says `front end NOT BUILT`. The
build command must include `npm run build`, which builds `web/dist` first.

### Assets 404, or "unexpected token '<'" in the browser console

`web/dist/assets` is missing or stale. Rebuild. A missing asset correctly
returns a 404 rather than `index.html`, which is why the error names the asset.

### API returns HTML instead of JSON

Something is serving `index.html` for `/api/*`. In this app the SPA fallback
explicitly skips `/api` and `/uploads`; if you put another proxy in front, it
must do the same.

### Login appears to work but every page bounces back to sign-in

The session cookie is being dropped. Almost always one of:

- **Site is on HTTP while `COOKIE_SECURE` is on.** Enable SSL, or set
  `COOKIE_SECURE=false` temporarily — the startup log warns when it is off.
- **`TRUST_PROXY` unset behind the proxy**, so the app thinks the request is
  insecure. Set `TRUST_PROXY=1`.
- **`APP_URL` does not match the browsed domain**, so the request is
  cross-origin. Make them the same.

### 403 "CSRF token missing or invalid"

The `mos_csrf` cookie is not coming back as the `x-csrf-token` header. This
works out of the box same-origin; it breaks if the API is served from a
different origin than the page. Keep them same-origin, or set `CORS_ORIGIN` to
the exact page origin.

### 429 Too Many Requests

Rate limiting is working. Defaults are 300 requests per 15 minutes per IP, and
tighter on login. If every visitor shares one apparent IP, `TRUST_PROXY` is
probably wrong. Tune with `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MIN` rather
than removing the limiter.

### AI writes generic copy

No `OPENAI_API_KEY` is set, so the built-in template engine is generating it.
This is intended and every result is labelled "Built-in engine" in the UI. Add
the key to switch to a model.

### Migrations

`prisma migrate deploy` applies committed migrations and never destroys data.
If it reports drift, the database was changed outside Prisma — resolve it
deliberately; do not run `migrate reset` on production.

## Internal tooling

`tools/cli/` holds an earlier document-based planning CLI (`mos`) — quarterly
pacing, channel scorecards, a content-brief scaffolder. It is **not** part of the
product and nothing in the web application depends on it. Its own tests still
run with `node --test "tools/cli/test/*.test.js"`. The strategy documents that
came with it live in `docs/product/`.
