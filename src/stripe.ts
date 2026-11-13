import { hmacSha256Hex, safeEqual } from "./crypto";
import type { Env } from "./types";

const API = "https://api.stripe.com/v1";
const TOLERANCE_S = 300;

/** Minimal form-encoded Stripe call (avoids the SDK; fine for the few endpoints we use). */
export async function stripeRequest<T>(
  env: Env,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const body = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`stripe: ${body.error?.message ?? res.status}`);
  return body;
}

/** Verifies the `Stripe-Signature` header over the raw body (HMAC-SHA256, v1 scheme). */
export async function verifyStripeSignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const ts = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!ts || sigs.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_S) return false;
  const expected = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
  return sigs.some((s) => safeEqual(s, expected));
}

export type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, any> };
};
