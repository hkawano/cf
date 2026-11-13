import type { Env } from "./types";

export async function sendMagicLink(env: Env, to: string, link: string): Promise<void> {
  if (!env.RESEND_API_KEY) {
    // Dev fallback: no email provider configured, print the link.
    console.log(`[dev] magic link for ${to}: ${link}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to,
      subject: "Your sign-in link",
      text: `Sign in: ${link}\n\nThis link expires in 15 minutes and works once. If you didn't request it, ignore this email.`,
    }),
  });
  if (!res.ok) {
    console.error("resend failed", res.status, await res.text());
    throw new Error("email_send_failed");
  }
}
