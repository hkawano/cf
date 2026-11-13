const $ = (s) => document.querySelector(s);
const msg = (t) => { const m = $("#msg"); if (m) m.textContent = t; };
const api = async (path, body) => {
  const res = await fetch(path, body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { res, data: await res.json().catch(() => ({})) };
};
const page = location.pathname.replace(/\.html$/, "");

if (page.endsWith("/login")) {
  $("#login").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { res } = await api("/api/auth/request", { email: new FormData(e.target).get("email") });
    msg(res.ok ? "Check your inbox for a sign-in link." : "Could not send the link. Try again.");
  });
}

if (page.endsWith("/verify")) {
  const token = new URLSearchParams(location.search).get("token");
  api("/api/auth/verify", { token }).then(({ res }) => {
    if (res.ok) location.replace("/members");
    else msg("This link is invalid or expired. Request a new one.");
  });
}

if (page.endsWith("/pricing")) {
  $("#subscribe").addEventListener("click", async () => {
    const { res, data } = await api("/api/billing/checkout", {});
    if (res.status === 401) return location.assign("/login");
    if (data.url) location.assign(data.url); else msg(data.error || "Checkout failed");
  });
}

if (page.endsWith("/members")) {
  (async () => {
    const { data: me } = await api("/api/me");
    if (!me.user) return location.replace("/login");
    $("#who").textContent = `Signed in as ${me.user.email}`;
    $("#logout").hidden = false;
    $("#logout").onclick = async () => { await api("/api/auth/logout", {}); location.assign("/"); };
    const { res, data } = await api("/api/members/content");
    if (res.ok) {
      $("#content").innerHTML = "";
      for (const l of data.lessons) {
        const h = document.createElement("h3"); h.textContent = l.title;
        const p = document.createElement("p"); p.textContent = l.body;
        $("#content").append(h, p);
      }
    } else if (res.status === 402) {
      $("#content").innerHTML = '<p>You need an active membership. <a href="/pricing">See pricing</a>.</p>';
    }
    if (me.subscription) {
      $("#portal").hidden = false;
      $("#portal").onclick = async () => { const { data } = await api("/api/billing/portal", {}); if (data.url) location.assign(data.url); };
    }
  })();
}
