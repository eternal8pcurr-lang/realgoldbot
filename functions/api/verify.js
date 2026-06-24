// ============================================================================
// Access-code check — BACKEND
// ----------------------------------------------------------------------------
// The gate screen calls this when a visitor submits a code, so we can let them
// in (or reject them) WITHOUT spending an Anthropic API call. The real gate is
// still enforced on every chat message in chat.js — this is just for nice UX.
// ============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, 400);
  }
  const valid = (env.ACCESS_CODES || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const given = (body.code || "").trim();
  const ok = given.length > 0 && valid.includes(given);
  return json({ ok }, ok ? 200 : 401);
}
