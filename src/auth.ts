import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { randomToken, sha256 } from "./crypto";
import type { AppEnv, Env, User } from "./types";

const SESSION_COOKIE = "sid";
const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days
const LOGIN_TOKEN_TTL_S = 15 * 60;
const MAX_LOGIN_EMAILS_PER_HOUR = 5;

const now = () => Math.floor(Date.now() / 1000);

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Returns a one-time token (plaintext) or null if the email is rate limited. */
export async function createLoginToken(env: Env, email: string): Promise<string | null> {
  const since = now() - 3600;
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?",
  )
    .bind(email, since)
    .first<{ n: number }>();
  if ((row?.n ?? 0) >= MAX_LOGIN_EMAILS_PER_HOUR) return null;

  const token = randomToken();
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_tokens WHERE expires_at < ?").bind(t - 3600),
    env.DB.prepare(
      "INSERT INTO login_tokens (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)",
    ).bind(await sha256(token), email, t + LOGIN_TOKEN_TTL_S, t),
  ]);
  return token;
}

/** Consumes a login token (single use) and returns the user, creating them on first login. */
export async function consumeLoginToken(env: Env, token: string): Promise<User | null> {
  const hash = await sha256(token);
  // DELETE ... RETURNING makes consumption atomic: a token can only succeed once.
  const row = await env.DB.prepare(
    "DELETE FROM login_tokens WHERE token_hash = ? RETURNING email, expires_at",
  )
    .bind(hash)
    .first<{ email: string; expires_at: number }>();
  if (!row || row.expires_at < now()) return null;

  const existing = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(row.email)
    .first<User>();
  if (existing) return existing;

  const user: User = { id: crypto.randomUUID(), email: row.email };
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)")
    .bind(user.id, user.email, now())
    .run();
  // Re-read in case of a concurrent insert for the same email.
  return (await env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(user.email)
    .first<User>())!;
}

export async function startSession(c: Context<AppEnv>, userId: string): Promise<void> {
  const sid = randomToken();
  await c.env.DB.prepare("INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(sid), userId, now() + SESSION_TTL_S)
    .run();
  setCookie(c, SESSION_COOKIE, sid, {
    httpOnly: true,
    secure: new URL(c.env.APP_URL).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_S,
  });
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    await c.env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(sid)).run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** Loads the user (if any) into c.var.user. Never rejects. */
export const loadUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("user", null);
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    const user = await c.env.DB.prepare(
      `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
      .bind(await sha256(sid), now())
      .first<User>();
    c.set("user", user ?? null);
  }
  await next();
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) return c.json({ error: "unauthorized" }, 401);
  await next();
};

export const requireActiveMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const sub = await c.env.DB.prepare(
    "SELECT status, current_period_end FROM subscriptions WHERE user_id = ?",
  )
    .bind(user.id)
    .first<{ status: string; current_period_end: number | null }>();
  const active = sub && (sub.status === "active" || sub.status === "trialing");
  if (!active) return c.json({ error: "subscription_required" }, 402);
  await next();
};

/** CSRF defence for cookie-authenticated state-changing requests: same-origin only. */
export const sameOriginOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    const origin = c.req.header("Origin");
    if (!origin || origin !== new URL(c.env.APP_URL).origin) {
      return c.json({ error: "bad_origin" }, 403);
    }
  }
  await next();
};
