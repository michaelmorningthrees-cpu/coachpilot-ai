# Security Notes — CoachPilot AI

## ⚠️ Rotate any leaked credentials immediately

During development, real secrets were placed in `.env` and appeared in terminal
output / chat logs. **Treat all of the following as compromised and rotate them
before going to production:**

| Secret | Where to rotate | Notes |
|--------|-----------------|-------|
| `OPENROUTER_API_KEY` | https://openrouter.ai/ → Keys | Delete the old key, create a new one. |
| `GOOGLE_PRIVATE_KEY` / service account | Google Cloud Console → IAM → Service Accounts → Keys | Delete the exposed key; generate a new JSON key. Consider rotating the whole service account if unsure. |
| `WHATSAPP_TOKEN` | Meta App Dashboard → WhatsApp → API Setup | Regenerate the access token (use a System User token for production). |
| `WHATSAPP_APP_SECRET` | Meta App Dashboard → Settings → Basic | Reset if it was ever exposed. |
| `WEBHOOK_VERIFY_TOKEN` | Your own value (Meta webhook config) | Pick a new random string and update both sides. |

## Secret handling rules

- **Never commit `.env`.** It is listed in `.gitignore`. `.env.example` must
  contain placeholders only — never real values.
- **Never log API keys, tokens, or private keys.** Logs may go to third-party
  log sinks. Phone numbers are masked to the last 4 digits in application logs.
- Prefer a secret manager (GCP Secret Manager, AWS Secrets Manager, Doppler)
  over `.env` files in deployed environments.
- Use a **Meta System User** long-lived token in production rather than the
  temporary 24-hour token from the API Setup page.

## Webhook security

- `POST /webhook` verifies Meta's `X-Hub-Signature-256` header (HMAC-SHA256 of
  the raw request body using `WHATSAPP_APP_SECRET`).
- Invalid or missing signatures are rejected with `403`.
- A development-only bypass exists for local `curl` testing:
  set `NODE_ENV=development` and `ALLOW_UNSIGNED_WEBHOOKS=true`.
  **This bypass is ignored when `NODE_ENV` is not `development`.**
