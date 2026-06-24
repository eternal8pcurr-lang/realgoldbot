// ============================================================================
// RealGold Assistant — BACKEND ("back office")
// ----------------------------------------------------------------------------
// This code runs on Cloudflare's servers, never in the visitor's browser.
// It is the ONLY place your secret Anthropic API key lives. On every message it:
//   1. Checks the visitor's access code (the gate).
//   2. Checks the visitor hasn't gone over their message limits (your bill).
//   3. Loads your two knowledge files as the bot's rulebook and asks Claude.
//   4. Streams the answer back to the chat page.
//
// You should not need to edit this file for normal use. The things you WILL
// change (codes, limits, API key) live as "environment variables" / "secrets"
// in Cloudflare (and in the .dev.vars file while testing on your computer).
// The few knobs you might tweak are grouped in CONFIG just below.
// ============================================================================

import { GUARDRAILS, CONTENT, COMPANY } from "./_knowledge.js";

const CONFIG = {
  // Which Claude model answers. (Requested: claude-sonnet-4-6.)
  MODEL: "claude-sonnet-4-6",

  // Max length of a single answer, in tokens (~3-4 chars each). 1024 keeps the
  // briefing tone tight and your costs predictable.
  MAX_TOKENS: 1024,

  // Rate limits per visitor. These are the DEFAULTS; you can override them
  // without touching code by setting RATE_PER_HOUR / RATE_PER_DAY in Cloudflare.
  DEFAULT_PER_HOUR: 20,
  DEFAULT_PER_DAY: 100,

  // Safety caps so a single request can't be abused to run up cost.
  MAX_MESSAGE_CHARS: 4000, // longest single question we'll accept
  MAX_HISTORY: 20, // how many prior turns we keep as context
};

// ---------------------------------------------------------------------------
// The bot's "rulebook": your two knowledge files, wrapped with framing that
// tells Claude how to behave. Part 1 of the guardrails is always in force.
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
  const wrapper = `You are the RealGold Assistant. Everything you say must comply with the OPERATING INSTRUCTIONS & GUARDRAILS and may draw only on the KNOWLEDGE provided below. Follow Part 1 of the guardrails at all times. If something is not covered, say so plainly and offer to connect the person with the team.

EMAIL ROUTING — IMPORTANT BEHAVIOR:
When the guardrails tell you to route a question to a human (Ken@real.gold) — i.e. for specific tax/legal advice, projected returns, deal terms/pricing, anything not covered here, or anything requiring a promise — first give your brief, accurate general answer, then invite the person to reach Ken at Ken@real.gold or leave their email. WHENEVER you make that invitation, append this exact marker on its very last line, by itself: [[OFFER_EMAIL]]
The marker is a silent signal to the website to show an email box; never explain or mention the marker itself. Do not output the marker in any other situation.`;

  // The three knowledge documents, combined. This block is identical on every
  // request, so we let Anthropic cache it (cache_control) to cut cost/latency.
  const knowledge = `===== OPERATING INSTRUCTIONS & GUARDRAILS (always in force) =====\n\n${GUARDRAILS}\n\n===== DEEP KNOWLEDGE: THE DST, 1031 ELIGIBILITY & OWNERSHIP MECHANICS =====\n\n${CONTENT}\n\n===== COMPANY, FUNDING, STRUCTURE & MODEL (incl. the current raise and Keep-ons) =====\n\n${COMPANY}`;

  return [
    { type: "text", text: wrapper },
    { type: "text", text: knowledge, cache_control: { type: "ephemeral" } },
  ];
}

// ---------------------------------------------------------------------------
// Small JSON-response helper.
// ---------------------------------------------------------------------------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// Access-code gate. Codes are stored in the ACCESS_CODES setting as a
// comma-separated list, e.g.  REALGOLD2026, PARTNER-JANE
// ---------------------------------------------------------------------------
function codeIsValid(submitted, env) {
  const raw = (env.ACCESS_CODES || "").trim();
  if (!raw) return false;
  const valid = raw
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  const given = (submitted || "").trim();
  return given.length > 0 && valid.includes(given);
}

// ---------------------------------------------------------------------------
// Rate limiting. We identify a visitor by their access code + their IP address,
// and keep two counters in Cloudflare KV (a tiny key/value store): one for the
// current hour, one for the current day. Each counter auto-expires.
//
// Returns { ok: true } or { ok: false, scope: "hour"|"day", limit, retryHint }.
// If KV isn't configured, we "fail open" (allow) so testing isn't blocked.
// ---------------------------------------------------------------------------
async function checkRateLimit(env, request, code) {
  const kv = env.RATE_LIMIT;
  if (!kv) return { ok: true }; // KV not bound (e.g. first local run) -> allow

  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for") ||
    "local";
  const id = `${code}:${ip}`;

  const perHour = Number(env.RATE_PER_HOUR) || CONFIG.DEFAULT_PER_HOUR;
  const perDay = Number(env.RATE_PER_DAY) || CONFIG.DEFAULT_PER_DAY;

  const now = Date.now();
  const hourBucket = Math.floor(now / 3_600_000); // changes every hour
  const dayBucket = Math.floor(now / 86_400_000); // changes every day

  const hourKey = `rl:${id}:h:${hourBucket}`;
  const dayKey = `rl:${id}:d:${dayBucket}`;

  const [hourVal, dayVal] = await Promise.all([
    kv.get(hourKey),
    kv.get(dayKey),
  ]);
  const hourCount = Number(hourVal) || 0;
  const dayCount = Number(dayVal) || 0;

  if (hourCount >= perHour)
    return { ok: false, scope: "hour", limit: perHour };
  if (dayCount >= perDay) return { ok: false, scope: "day", limit: perDay };

  // Count this message. (KV has no atomic increment; at this scale a rare
  // off-by-one under heavy concurrency is acceptable for bill protection.)
  await Promise.all([
    kv.put(hourKey, String(hourCount + 1), { expirationTtl: 3600 }),
    kv.put(dayKey, String(dayCount + 1), { expirationTtl: 86_400 }),
  ]);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Turn Anthropic's streaming format into a plain stream of text chunks, so the
// website can simply append whatever it receives.
// ---------------------------------------------------------------------------
function toPlainTextStream(upstreamBody) {
  const reader = upstreamBody.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    // `start` pumps the whole upstream stream through in one driven loop, which
    // is the reliable pattern on the Workers runtime (a per-chunk `pull` can
    // stall). Answers are short, so eager pumping is fine.
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // keep last partial line for next round
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const evt = JSON.parse(payload);
              if (
                evt.type === "content_block_delta" &&
                evt.delta &&
                typeof evt.delta.text === "string"
              ) {
                controller.enqueue(encoder.encode(evt.delta.text));
              }
            } catch {
              // ignore keep-alive / non-JSON lines
            }
          }
        }
      } catch {
        // upstream interrupted — just end the stream cleanly
      } finally {
        controller.close();
      }
    },
    cancel() {
      reader.cancel();
    },
  });
}

// ---------------------------------------------------------------------------
// Main handler — Cloudflare calls this for POST /api/chat
// ---------------------------------------------------------------------------
export async function onRequestPost({ request, env }) {
  // Make sure the key is configured before anything else.
  if (!env.ANTHROPIC_API_KEY) {
    return json(
      { error: "Server is not configured yet (missing API key)." },
      500
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Bad request." }, 400);
  }

  // 1) GATE — check the access code.
  if (!codeIsValid(body.code, env)) {
    return json({ error: "Invalid access code." }, 401);
  }

  // Validate the conversation the page sent us.
  const history = Array.isArray(body.messages) ? body.messages : [];
  const cleaned = history
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0
    )
    .slice(-CONFIG.MAX_HISTORY)
    .map((m) => ({
      role: m.role,
      content: m.content.slice(0, CONFIG.MAX_MESSAGE_CHARS),
    }));

  if (cleaned.length === 0 || cleaned[cleaned.length - 1].role !== "user") {
    return json({ error: "No question provided." }, 400);
  }

  // 2) RATE LIMIT.
  const rl = await checkRateLimit(env, request, body.code.trim());
  if (!rl.ok) {
    const msg =
      rl.scope === "hour"
        ? `You've reached this hour's limit of ${rl.limit} messages. Please try again later.`
        : `You've reached today's limit of ${rl.limit} messages. Please try again tomorrow.`;
    return json({ error: msg, rateLimited: true }, 429);
  }

  // 3) ASK CLAUDE (streaming).
  const anthropicReq = {
    model: CONFIG.MODEL,
    max_tokens: CONFIG.MAX_TOKENS,
    system: buildSystemPrompt(),
    messages: cleaned,
    stream: true,
  };

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicReq),
    });
  } catch {
    return json({ error: "Could not reach the assistant. Try again." }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    console.error("Anthropic error:", upstream.status, detail);
    return json(
      { error: "The assistant had a problem. Please try again." },
      502
    );
  }

  // 4) Stream a clean text response back to the page.
  return new Response(toPlainTextStream(upstream.body), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
