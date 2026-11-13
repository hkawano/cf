# Membership site on Cloudflare Workers

Single Worker (Hono) + static assets + D1. Magic-link auth, Stripe subscriptions, gated API.

## Layout
- `src/index.ts` routes, Stripe webhook handling
- `src/auth.ts` magic links, sessions, middleware (CSRF origin check, `requireActiveMember`)
- `src/stripe.ts` signature verification and API helper (no SDK)
- `public/` static pages (served free, only `/api/*` invokes the Worker)
- `migrations/` D1 schema

## Local dev
```bash
npm install
cp .dev.vars.example .dev.vars   # leave RESEND_API_KEY empty: links print to the console
npm run db:local
npm run dev
```

## Deploy
```bash
npx wrangler login
npx wrangler d1 create membership-db        # paste database_id into wrangler.jsonc
npm run db:remote
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret put STRIPE_PRICE_ID
```
Then set `APP_URL` (must be the exact https origin) and `EMAIL_FROM` (verified Resend domain) in `wrangler.jsonc` and run `npm run deploy`.

Stripe: create a recurring Price, add a webhook endpoint `https://<APP_URL>/api/stripe/webhook` listening to
`checkout.session.completed` and `customer.subscription.created|updated|deleted`, and enable the Customer Portal.

## Notes
- `APP_URL` drives the CSRF Origin check and cookie `Secure` flag; a mismatch makes every POST return 403.
- HTML pages are public. Only `/api/*` content is gated, so put paid material behind the API (D1 rows or R2 signed URLs), not in `public/`.
- Webhook events can arrive out of order; a stale event can briefly overwrite a newer status. For stricter handling, compare `event.created` per subscription.
- Login emails are limited to 5/hour per address (D1 counter). Add IP-based limits via a Cloudflare rate limiting rule for abuse protection.
