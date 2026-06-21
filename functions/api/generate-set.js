// Cloudflare Pages Function
// Route: POST /api/generate-set
//
// This file runs ONLY on Cloudflare's servers, never in the browser.
// It reads the Gemini API key from an environment variable (set in the
// Cloudflare dashboard, never committed to git, never sent to any client),
// calls Gemini, and returns just the word list as JSON.
//
// The frontend never sees, stores, or has any path to the real key.

const SYSTEM_PROMPT = `You generate word lists for a party game called Imposter, similar to Spyfall or Codenames Undercover. Given a theme phrase, produce exactly 50 short, well-known, easy-to-guess words or phrases related to that theme. Rules: each entry must be instantly recognizable to a general audience (think Eiffel Tower, Minecraft, Avengers level of fame, nothing obscure). Each entry must be 1-4 words. No duplicates. No numbering. No explanations. Respond ONLY with a JSON array of exactly 50 strings, nothing else, no markdown formatting, no backticks, no surrounding text.`;

const MAX_PHRASE_LENGTH = 80;

// Simple in-memory rate limiting per Cloudflare edge instance.
// Not a substitute for proper rate limiting at scale, but enough to stop
// a casual abuser from running your key dry with rapid repeat requests.
// For real production traffic, use Cloudflare's built-in Rate Limiting rules
// (dashboard > your Pages project > Security > WAF) instead, which work
// across all edge locations rather than per-instance.
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 8;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(ip)) {
      return jsonResponse({ error: 'Too many requests. Wait a moment and try again.' }, 429);
    }

    if (!env.GEMINI_API_KEY) {
      return jsonResponse({ error: 'Server is not configured with an API key yet.' }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: 'Invalid request body.' }, 400);
    }

    const phrase = (body && body.phrase ? String(body.phrase) : '').trim();
    if (!phrase) {
      return jsonResponse({ error: 'Theme phrase is required.' }, 400);
    }
    if (phrase.length > MAX_PHRASE_LENGTH) {
      return jsonResponse({ error: 'Theme phrase is too long.' }, 400);
    }

    const words = await callGemini(env.GEMINI_API_KEY, phrase);

    if (!words || words.length < 10) {
      return jsonResponse({ error: 'Could not generate enough cards for that theme. Try a different phrase.' }, 502);
    }

    return jsonResponse({ words });

  } catch (err) {
    console.error('generate-set error:', err);
    return jsonResponse({ error: 'Something went wrong generating that set.' }, 500);
  }
}

// Reject any non-POST method explicitly rather than falling through silently.
export async function onRequestGet() {
  return jsonResponse({ error: 'Use POST.' }, 405);
}

async function callGemini(apiKey, phrase) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: `${SYSTEM_PROMPT}\n\nTheme: ${phrase}` }]
        }
      ],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 1200,
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error('Gemini API error:', response.status, errText);
    throw new Error(`Gemini request failed (${response.status})`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No text in Gemini response');

  let clean = text.trim();
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed)) throw new Error('Gemini response was not a JSON array');

  return parsed
    .filter(x => typeof x === 'string' && x.trim().length > 0)
    .map(x => x.trim())
    .slice(0, 50);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
