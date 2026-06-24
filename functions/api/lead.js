// ============================================================================
// Email capture ("a human, please") — BACKEND
// ----------------------------------------------------------------------------
// When the bot routes a sensitive question to a person, the chat page offers an
// email box. Submitting it lands here. We:
//   1. Re-check the access code.
//   2. Store the lead in Cloudflare KV (the LEADS store) so you never lose it.
//   3. (Optional, off by default) email it to you. See the clearly-marked block
//      near the bottom — you chose to wire up email delivery later, so right now
//      leads are simply stored and you can read them with /api/leads-admin.
// ============================================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function codeIsValid(submitted, env) {
  const valid = (env.ACCESS_CODES || "")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const given = (submitted || "").trim();
  return given.length > 0 && valid.includes(given);
}

function looksLikeEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  if (!codeIsValid(body.code, env)) {
    return json({ error: "Invalid access code." }, 401);
  }

  const email = (body.email || "").trim();
  if (!looksLikeEmail(email)) {
    return json({ error: "Please enter a valid email address." }, 400);
  }

  const note = (body.note || "").toString().slice(0, 2000);
  const message = (body.message || "").toString().slice(0, 4000);
  const when = new Date().toISOString();
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for") ||
    "local";

  const lead = { email, message, note, when, ip, code: body.code.trim() };

  // 2) Store the lead in KV (if configured). Keyed by time so they sort nicely.
  if (env.LEADS) {
    const key = `lead:${when}:${Math.floor(Math.random() * 1e6)}`;
    await env.LEADS.put(key, JSON.stringify(lead));
  } else {
    // No store bound yet (e.g. very first local run) — at least log it.
    console.log("LEAD (not stored, no KV):", JSON.stringify(lead));
  }

  // 3) OPTIONAL EMAIL DELIVERY — wire this up later.
  // ---------------------------------------------------------------------
  // You chose "decide later" for email delivery. When you're ready (e.g. with
  // Resend, https://resend.com — free tier), set two settings in Cloudflare:
  //   RESEND_API_KEY  = your Resend key
  //   LEAD_TO_EMAIL   = Ken@real.gold
  // ...and this block will email each lead to you automatically. Until then it
  // is skipped and leads are simply stored above.
  if (env.RESEND_API_KEY && env.LEAD_TO_EMAIL) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: env.LEAD_FROM_EMAIL || "RealGold Assistant <onboarding@resend.dev>",
          to: [env.LEAD_TO_EMAIL],
          reply_to: email,
          subject: `New RealGold lead: ${email}`,
          text: `A visitor asked to be contacted.\n\nEmail: ${email}\nWhen: ${when}\nAccess code: ${lead.code}\n\nTheir message:\n${message || "(none)"}\n\nContext / note:\n${note || "(none)"}\n\n— Reply directly to this email to reach the visitor.`,
        }),
      });
    } catch (e) {
      // Don't fail the visitor's request just because email sending hiccuped;
      // the lead is already safely stored in KV above.
      console.error("Lead email send failed:", e);
    }
  }

  return json({ ok: true });
}
