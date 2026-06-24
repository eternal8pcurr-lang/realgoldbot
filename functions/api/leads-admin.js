// ============================================================================
// View captured leads — BACKEND (private, for Ken only)
// ----------------------------------------------------------------------------
// Visit:  https://YOUR-SITE/api/leads-admin?key=YOUR_ADMIN_KEY
// It returns every email a visitor left, newest first, as a simple list.
//
// The ADMIN_KEY setting protects this page. Set it in Cloudflare (and in
// .dev.vars while testing). If it isn't set, this page is disabled.
// ============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";

  if (!env.ADMIN_KEY) {
    return json({ error: "Admin view is disabled (no ADMIN_KEY set)." }, 404);
  }
  if (key !== env.ADMIN_KEY) {
    return json({ error: "Not authorized." }, 401);
  }
  if (!env.LEADS) {
    return json({ error: "Lead storage is not configured yet.", leads: [] });
  }

  // List up to 1000 stored leads.
  const list = await env.LEADS.list({ limit: 1000 });
  const leads = [];
  for (const k of list.keys) {
    const raw = await env.LEADS.get(k.name);
    if (raw) {
      try {
        leads.push(JSON.parse(raw));
      } catch {
        /* skip unreadable entries */
      }
    }
  }
  // Newest first.
  leads.sort((a, b) => (a.when < b.when ? 1 : -1));

  return json({ count: leads.length, leads });
}
