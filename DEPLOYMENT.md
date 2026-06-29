# Deployment Guide — CoachPilot AI

This guide covers deploying the webhook server to **Render** or **Railway** and
connecting the **Meta WhatsApp Cloud API** webhook.

> Scope: single-coach MVP. No dashboard, payments, or multi-coach.

---

## 1. Run locally

```bash
# Install dependencies
npm install

# Copy env template and fill in real values
cp .env.example .env

# Development (ts-node, no build step)
npm run dev

# Development with auto-reload
npm run dev:watch

# Production-style build + run
npm run build      # compiles TypeScript to dist/
npm start          # runs node dist/app.js

# Type-check only
npm run typecheck

# Health check
curl http://localhost:3001/health
# -> {"status":"ok","service":"CoachPilot AI","environment":"development","baseUrl":"http://localhost:3001","timestamp":"..."}
```

Requires **Node.js >= 20** (see `engines` in `package.json`).

---

## 2. Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | recommended | `production` when deployed; `development` locally. |
| `BASE_URL` | **yes (prod)** | Public base URL for all callbacks, e.g. `https://coachpilot-ai.onrender.com`. Must start with `https://` in production. Dev falls back to `http://localhost:<PORT>`. |
| `PORT` | auto | Render/Railway inject this; the app reads `process.env.PORT`. |
| `WEBHOOK_VERIFY_TOKEN` | yes | Webhook verification token; must match Meta dashboard. (Legacy `WHATSAPP_VERIFY_TOKEN` still accepted as fallback.) |
| `WHATSAPP_APP_SECRET` | yes | Meta App Secret; verifies `X-Hub-Signature-256`. |
| `WHATSAPP_TOKEN` | yes | Meta access token (use a System User token in prod). |
| `WHATSAPP_PHONE_NUMBER_ID` | yes | WhatsApp Business phone number ID. |
| `WHATSAPP_API_VERSION` | optional | Graph API version (default `v25.0`). |
| `META_APP_ACCESS_TOKEN` | optional | App access token for `debug_token` validation in post-signup setup. Falls back to `{APP_ID}|{APP_SECRET}`. |
| `ENABLE_REAL_WHATSAPP` | yes (prod) | Set `true` to actually send replies via Meta. |
| `OPENROUTER_API_KEY` | yes | OpenRouter key for the intent parser. |
| `OPENROUTER_BASE_URL` | optional | Default `https://openrouter.ai/api/v1`. |
| `OPENROUTER_MODEL` | optional | Default `deepseek/deepseek-chat`. |
| `GOOGLE_CLIENT_EMAIL` | yes | Calendar service account email. |
| `GOOGLE_PRIVATE_KEY` | yes | Service account private key (keep literal `\n`). |
| `GOOGLE_CALENDAR_ID` | yes | Coach's calendar ID. |
| `GOOGLE_OAUTH_CLIENT_ID` | for OAuth | Web OAuth client id (per-coach calendar connect). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | for OAuth | Web OAuth client secret. |
| `GOOGLE_OAUTH_REDIRECT_URI` | optional | Overrides the OAuth callback; derived from `BASE_URL` when unset. |
| `WHATSAPP_APP_ID` | for Embedded Signup | Meta App ID (coach self-connect). |
| `WHATSAPP_CONFIG_ID` | for Embedded Signup | Embedded Signup configuration id. |
| `GOOGLE_CALENDAR_TIMEZONE` | optional | Default `Asia/Hong_Kong`. |
| `COACH_TIMEZONE` | optional | Coach timezone for working hours (default `Asia/Hong_Kong`). |
| `SESSION_DURATION_MINUTES` | optional | Session length (default `60`). |
| `BUFFER_MINUTES` | optional | Gap between sessions (default `0`). |
| `WORKING_HOURS_JSON` | optional | Weekly hours per day; default every day 18:00–22:00. |
| `FIREBASE_PROJECT_ID` | yes | Firestore project (context + idempotency). |
| `FIREBASE_CLIENT_EMAIL` | yes | Firebase service account email. |
| `FIREBASE_PRIVATE_KEY` | yes | Firebase service account key (keep literal `\n`). |
| `ALLOW_UNSIGNED_WEBHOOKS` | **must be false/unset in prod** | Dev-only signature bypass. |

**Startup safety (enforced in code):**

- If `NODE_ENV=production` **and** `ALLOW_UNSIGNED_WEBHOOKS=true`, the app
  **refuses to start**.
- In production, `BASE_URL` is **required**, must start with `https://`, and must
  not point to `localhost`/`127.0.0.1`. A `GOOGLE_OAUTH_REDIRECT_URI` pointing at
  localhost is also rejected.
- In production, missing any of these **critical** vars aborts startup:
  `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`,
  `OPENROUTER_API_KEY`, `GOOGLE_CALENDAR_ID`, `FIREBASE_PROJECT_ID`.
  In development, the same vars only log a warning (degraded mode).

**Callback URLs are derived from `BASE_URL`:**

| Callback | URL |
|----------|-----|
| Meta webhook | `${BASE_URL}/webhook` |
| Google OAuth | `${BASE_URL}/oauth/google/callback` (unless `GOOGLE_OAUTH_REDIRECT_URI` set) |
| WhatsApp Embedded Signup | `${BASE_URL}/coach/whatsapp/embedded/callback` |

> For multi-line keys (`GOOGLE_PRIVATE_KEY`, `FIREBASE_PRIVATE_KEY`), paste the
> value with literal `\n` sequences and wrap in double quotes. The app converts
> them to real newlines at runtime.

---

## 3. Render setup

1. **New → Web Service**, connect the repo.
2. **Environment:** Node.
3. **Build command:**

   ```
   npm install && npm run build
   ```

4. **Start command:**

   ```
   npm start
   ```

5. **Environment variables:** add every variable from the table above.
   Set `NODE_ENV=production`, `BASE_URL=https://coachpilot-ai.onrender.com`,
   `ALLOW_UNSIGNED_WEBHOOKS=false`, `ENABLE_REAL_WHATSAPP=true`.
   Do **not** set `PORT` (Render injects it).
6. **Health check path:** `/health`.
7. Deploy. Your webhook URL will be:

   ```
   https://coachpilot-ai.onrender.com/webhook
   ```

### Exact Render env values (production)

```
NODE_ENV=production
BASE_URL=https://coachpilot-ai.onrender.com
ALLOW_UNSIGNED_WEBHOOKS=false
ENABLE_REAL_WHATSAPP=true
# GOOGLE_OAUTH_REDIRECT_URI is optional — derived from BASE_URL when unset
```

---

## 4. Railway setup

1. **New Project → Deploy from repo.**
2. Railway auto-detects Node. If needed, set explicitly:
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
3. **Variables:** add the same environment variables as Render
   (`NODE_ENV=production`, no `ALLOW_UNSIGNED_WEBHOOKS`, do not set `PORT`).
4. Generate a public domain. Your webhook URL will be:

   ```
   https://your-app.up.railway.app/webhook
   ```

---

## 5. Meta WhatsApp webhook setup

In the **Meta App Dashboard → WhatsApp → Configuration → Webhook**:

1. **Callback URL:**

   ```
   https://coachpilot-ai.onrender.com/webhook
   ```

2. **Verify token:** the exact value of your `WEBHOOK_VERIFY_TOKEN`.
   Meta sends a `GET /webhook` handshake; the server echoes `hub.challenge`
   when the token matches.

3. Click **Verify and Save**.

4. **Subscribe to fields:** enable **`messages`**.

5. Ensure **`WHATSAPP_APP_SECRET`** is set in your deployment — every incoming
   `POST /webhook` must carry a valid `X-Hub-Signature-256`, or it is rejected
   with `403`.

6. In production, **`ALLOW_UNSIGNED_WEBHOOKS` must be `false`** (or unset).
   The unsigned bypass is for local `curl` testing only and is blocked at
   startup in production.

### Verifying after deploy

```bash
# Health
curl https://your-domain.com/health

# Webhook verification (simulating Meta's GET handshake)
curl "https://coachpilot-ai.onrender.com/webhook?hub.mode=subscribe&hub.verify_token=YOUR_VERIFY_TOKEN&hub.challenge=12345"
# -> 12345
```

Then send a WhatsApp message to your business number and watch the logs for
`[WHATSAPP INCOMING]` → `[INTENT PARSED]` → `[WHATSAPP OUTGOING]`.

---

## 6. External callback registration (production)

Register these exact URLs in the respective consoles:

- **Meta webhook callback:** `https://coachpilot-ai.onrender.com/webhook`
  (verify token = `WEBHOOK_VERIFY_TOKEN`; subscribe field `messages`)
- **Google OAuth redirect URI** (Google Cloud Console → Credentials → OAuth
  client → Authorized redirect URIs):
  `https://coachpilot-ai.onrender.com/oauth/google/callback`
- **WhatsApp Embedded Signup callback** (used by the coach dashboard front-end):
  `https://coachpilot-ai.onrender.com/coach/whatsapp/embedded/callback`
  (the Facebook Login for Business config must allow the app domain
  `coachpilot-ai.onrender.com`)

---

## 7. Operational notes

- **Graceful shutdown:** the server handles `SIGINT`/`SIGTERM`, stops accepting
  connections, drains in-flight requests, and exits (with a 10s force-exit
  safety net) — suitable for platform redeploys.
- **Logs:** phone numbers are masked to the last 4 digits; secrets are never
  logged.
- **Persistence:** conversation context and webhook idempotency use Firestore.
  Without Firebase credentials the app runs in degraded mode (no persistence),
  which is fine for local testing but **not** for production.
- See `SECURITY_NOTES.md` for credential rotation guidance.
