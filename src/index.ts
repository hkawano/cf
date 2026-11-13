import { Hono } from "hono";
import {
  consumeLoginToken,
  createLoginToken,
  endSession,
  loadUser,
  normalizeEmail,
  requireActiveMember,
  requireUser,
  sameOriginOnly,
  startSession,
} from "./auth";
import { sendMagicLink } from "./email";
import { stripeRequest, verifyStripeSignature, type StripeEvent } from "./stripe";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

// --- global middleware (webhook is server-to-server: no cookies, no Origin) ---
app.use("/api/*", async (c, next) => {
  if (c.req.path === "/api/stripe/webhook") return next();
  return sameOriginOnly(c, next);
});
app.use("/api/*", loadUser);

// --- auth ---
app.post("/api/auth/request", async (c) => {
  const body = await c.req.json().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return c.json({ error: "invalid_email" }, 400);

  const token = await createLoginToken(c.env, email);
  if (token) {
    const link = `${c.env.APP_URL}/verify?token=${token}`;
    try {
      await sendMagicLink(c.env, email, link);
    } catch {
      return c.json({ error: "email_failed" }, 502);
    }
  }
  // Same response whether rate limited or not, and whether the account exists or not.
  return c.json({ ok: true });
});

// POST (not GET) so email link scanners/prefetchers can't burn the one-time token.
app.post("/api/auth/verify", async (c) => {
  const body = await c.req.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token : "";
  const user = token ? await consumeLoginToken(c.env, token) : null;
  if (!user) return c.json({ error: "invalid_or_expired" }, 400);
  await startSession(c, user.id);
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  await endSession(c);
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ user: null });
  const sub = await c.env.DB.prepare(
    "SELECT status, current_period_end FROM subscriptions WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ status: string; current_period_end: number | null }>();
  return c.json({ user, subscription: sub ?? null });
});

// --- gated content (example) ---
app.get("/api/members/content", requireActiveMember, (c) =>
  c.json({
    lessons: [
      { id: 1, title: "Welcome", body: "Replace with real gated content (D1 rows or R2 signed URLs)." },
    ],
  }),
);

// --- billing ---
app.post("/api/billing/checkout", requireUser, async (c) => {
  const user = c.get("user")!;
  const existing = await c.env.DB.prepare(
    "SELECT stripe_customer_id, status FROM subscriptions WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ stripe_customer_id: string; status: string }>();
  if (existing && (existing.status === "active" || existing.status === "trialing")) {
    return c.json({ error: "already_subscribed" }, 409);
  }

  const params: Record<string, string> = {
    mode: "subscription",
    "line_items[0][price]": c.env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    client_reference_id: user.id,
    "subscription_data[metadata][user_id]": user.id,
    success_url: `${c.env.APP_URL}/members?checkout=success`,
    cancel_url: `${c.env.APP_URL}/pricing`,
  };
  if (existing) params.customer = existing.stripe_customer_id;
  else params.customer_email = user.email;

  const session = await stripeRequest<{ url: string }>(c.env, "/checkout/sessions", params);
  return c.json({ url: session.url });
});

app.post("/api/billing/portal", requireUser, async (c) => {
  const user = c.get("user")!;
  const row = await c.env.DB.prepare("SELECT stripe_customer_id FROM subscriptions WHERE user_id = ?")
    .bind(user.id)
    .first<{ stripe_customer_id: string }>();
  if (!row) return c.json({ error: "no_customer" }, 404);
  const session = await stripeRequest<{ url: string }>(c.env, "/billing_portal/sessions", {
    customer: row.stripe_customer_id,
    return_url: `${c.env.APP_URL}/members`,
  });
  return c.json({ url: session.url });
});

// --- Stripe webhook ---
app.post("/api/stripe/webhook", async (c) => {
  const raw = await c.req.text(); // signature is over the exact raw body
  const ok = await verifyStripeSignature(
    c.env.STRIPE_WEBHOOK_SECRET,
    raw,
    c.req.header("Stripe-Signature"),
  );
  if (!ok) return c.json({ error: "bad_signature" }, 400);

  const event = JSON.parse(raw) as StripeEvent;
  const t = Math.floor(Date.now() / 1000);

  const ins = await c.env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, received_at) VALUES (?, ?)")
    .bind(event.id, t)
    .run();
  if (ins.meta.changes === 0) return c.json({ ok: true, duplicate: true });

  try {
    await handleStripeEvent(c.env, event);
  } catch (err) {
    console.error("webhook handler failed", event.type, err);
    // Un-mark so Stripe's retry gets processed.
    await c.env.DB.prepare("DELETE FROM stripe_events WHERE id = ?").bind(event.id).run();
    return c.json({ error: "handler_failed" }, 500);
  }
  return c.json({ ok: true });
});

async function handleStripeEvent(env: AppEnv["Bindings"], event: StripeEvent): Promise<void> {
  const obj = event.data.object;
  const t = Math.floor(Date.now() / 1000);

  if (event.type === "checkout.session.completed" && obj.mode === "subscription") {
    const userId = obj.client_reference_id as string | null;
    if (!userId || !obj.customer) return;
    // Link customer -> user. Real status arrives via customer.subscription.* events.
    await env.DB.prepare(
      `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, updated_at)
       VALUES (?, ?, ?, 'incomplete', ?)
       ON CONFLICT (user_id) DO UPDATE SET
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         updated_at = excluded.updated_at`,
    )
      .bind(userId, obj.customer, obj.subscription ?? null, t)
      .run();
    return;
  }

  if (event.type.startsWith("customer.subscription.")) {
    const customerId = obj.customer as string;
    const bySub = await env.DB.prepare("SELECT user_id FROM subscriptions WHERE stripe_customer_id = ?")
      .bind(customerId)
      .first<{ user_id: string }>();
    const userId = bySub?.user_id ?? (obj.metadata?.user_id as string | undefined);
    if (!userId) throw new Error(`no user for customer ${customerId}`); // retried by Stripe

    const status = event.type === "customer.subscription.deleted" ? "canceled" : (obj.status as string);
    // Newer Stripe API versions moved current_period_end onto the subscription item.
    const periodEnd = (obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end ?? null) as number | null;

    await env.DB.prepare(
      `INSERT INTO subscriptions (user_id, stripe_customer_id, stripe_subscription_id, status, current_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         stripe_customer_id = excluded.stripe_customer_id,
         stripe_subscription_id = excluded.stripe_subscription_id,
         status = excluded.status,
         current_period_end = excluded.current_period_end,
         updated_at = excluded.updated_at`,
    )
      .bind(userId, customerId, obj.id, status, periodEnd, t)
      .run();
  }
}

app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
