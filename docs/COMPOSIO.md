# Composio — per-restaurant account connections

## What it is, and what it is not

Composio is a **third connection route**, beside direct OAuth (`Integration`)
and Upload-Post. It does not replace direct OAuth, which keeps doing what it
already does well: Facebook Page tokens, account selection, Meta / Google Ads
metric ingestion and publishing.

Composio adds:

- **Several accounts per platform per restaurant** ("Add another account").
  The direct model allows one `Integration` per platform per restaurant.
- **Self-service.** A restaurant owner or manager connects their own accounts
  from the restaurant portal (`/client/integrations`). The agency never handles
  their passwords.
- **Toolkits with no direct adapter here** (for example GA4 and Search Console),
  as long as the Composio project has an auth config for them.

What it does **not** add by itself: data. A connected Composio account is an
authorisation. Pulling a platform's figures into dashboards through Composio
tools is a further step: each tool call is metered, and each toolkit's
tools must be chosen and verified against a live account.

## How a restaurant connects

```
Integrations Center → platform → Connect account / Add another account
  POST /api/composio/:clientId/connections { authConfigId, alias? }
    → server checks the auth config is enabled in the project
    → POST /api/v3.1/connected_accounts/link  (user_id = <prefix>:client:<clientId>)
    → browser goes to Composio's hosted login, then to the platform's consent screen
    → back to …/integrations?composio=returned
  POST /api/composio/:clientId/sync
    → GET /api/v3.1/connected_accounts?user_ids=<that id>
    → every returned account's user_id is checked again; foreign ones are dropped
```

Connected is shown only once Composio reports the account `ACTIVE`, and the
row records how that was verified: `COMPOSIO_STATUS`, or `PROVIDER_CALL` when
`COMPOSIO_VERIFY_TOOL_<TOOLKIT>` names a read-only tool and the call succeeded.

| Composio status | Shown as |
|---|---|
| INITIALIZING, INITIATED | Pending approval |
| ACTIVE | Connected |
| EXPIRED | Token expired |
| FAILED, REVOKED | Reauthorization required |
| INACTIVE / disabled | Disconnected |
| last call 429 / 5xx / network | API error (status kept) |
| tool refused for permission | Missing permissions |
| no enabled auth config | Unsupported |

Composio renews OAuth tokens itself. Its manual refresh endpoint is deprecated,
so Reconnect opens a fresh login, and the old account is deleted only once the
new one is ACTIVE.

## Roles

`ClientRole` refines the restaurant-side `Role`, as defined in `server/src/lib/rbac.ts`:
owner, manager, marketing manager, content creator, financial analyst, viewer.
Owners and managers may connect and disconnect accounts. Content creators may
view connections but not change them. Consumption & cost is visible to Super
Admin and Agency Admin only.

## Activation runbook

Nothing below needs the key to pass through a chat, a ticket, or this repository.

### 1. Create the API key in Composio

1. Sign in at https://platform.composio.dev (the Composio dashboard).
2. Create or open the project you want this deployment to use. Use one project
   per environment if you later add staging.
3. Open the project's **Settings → API Keys**, create a key, and copy it once.
   Composio does not show it again; if you lose it, revoke it and create a new one.

### 2. Put it straight into Railway

1. Railway → project **Marketing Server** → service **@marketing-os/server** → **Variables**.
2. **New Variable**: name `COMPOSIO_API_KEY`, value: paste the key. Save.
3. Railway stages the change: press **Deploy** to apply it. The service
   restarts with the key. No code deploy is needed.
4. Optional, same screen: `COMPOSIO_PLAN_MONTHLY_USD`, `COMPOSIO_INCLUDED_CALLS`,
   `COMPOSIO_OVERAGE_PER_1K_USD` from your Composio plan, for the cost estimate.

To rotate the key, create a new one in Composio, replace the value in Railway,
deploy, then revoke the old key in Composio.

### 3. Check it from inside the deployment

Integrations Center → **Composio diagnostics** (Super Admin / Agency Admin). It runs on the Railway
server itself and reports:

- whether the server reaches `backend.composio.dev`. This is decided before the key matters;
- every auth config in the project, with its **real toolkit slug**;
- which of the slugs this code groups by actually exist in Composio.

If a platform's real slug is missing from `PLATFORM_FAMILIES`, its auth configs
still appear, as a card under the slug itself. Add the slug to the list to group it.

### 4. Create the auth configs

Composio dashboard → **Auth Configs** → **Create** → choose the toolkit
(Instagram first, then Facebook, then TikTok and Google). For production, choose
**your own OAuth app** and enter the platform app's client id and secret there,
in Composio and not in this application. Copy the redirect URI Composio shows
into the platform's developer console. Enable the auth config. It appears in the
Integrations Center within a minute (the catalogue is cached for 60 s).

### 5. First live test (safe)

1. Integrations Center → choose a test restaurant → Instagram → **Connect account**.
   Complete the Instagram consent with an account you are authorised to use.
2. Back on the page, the card shows **Connected** only once Composio reports ACTIVE.
3. **Add another account**: connect a second Instagram account to the same restaurant;
   both cards should show Connected.
4. Sign in as another restaurant's owner: none of the first restaurant's accounts are visible.
5. **Test connection**, **Sync now**, **Reconnect** (complete the login, and the old card
   disappears once the new one is active), **Disconnect** (on a test account).

None of these steps publishes, posts or spends: connecting only authorises.
Test connection makes a platform call only when `COMPOSIO_VERIFY_TOOL_<TOOLKIT>`
names a read-only tool. Choose one from the toolkit's tool list in Composio,
one whose name reads GET/LIST/FETCH, never CREATE/POST/PUBLISH.

## Setup (an administrator, once)

1. Create a Composio project and an API key; set `COMPOSIO_API_KEY` on the server.
2. In Composio, create one **auth config** per platform you want to offer.
   Use your own OAuth app (client id / secret) for Meta, TikTok and Google in
   production, so the consent screen shows your brand and the platform reviews
   your app's permissions. Composio-managed apps are for trying things out.
3. In each platform's developer console, add Composio's redirect URI to your
   OAuth app (Composio shows it on the auth config).
4. The Integrations Center lists every enabled auth config automatically.
   Adding a restaurant or a platform needs no code change.

## Not verified in this repository

The API shape was taken from Composio's generated client
(`@composio/client` 0.1.0-alpha.76). docs.composio.dev, composio.dev and
backend.composio.dev were not reachable from the environment this was built
in, so the following are **not verified**: toolkit slugs (the grouping in
`PLATFORM_FAMILIES` is best effort, and unknown slugs are still shown), the
pricing figures, and any live call. The tests use a fake that speaks the
generated client's response shapes.
