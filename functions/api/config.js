// ============================================================================
// Public page config — BACKEND
// ----------------------------------------------------------------------------
// Returns only the harmless bits the chat page needs before login: the clickable
// "guiding questions" (pulled from Part 8 of your knowledge file at build time).
// It deliberately exposes NO secrets and NONE of your internal guardrail text.
// ============================================================================

import { GUIDING_QUESTIONS } from "./_knowledge.js";

export async function onRequestGet() {
  return new Response(JSON.stringify({ guidingQuestions: GUIDING_QUESTIONS }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}
