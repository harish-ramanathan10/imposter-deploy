// Cloudflare Pages Function
// Route: POST /api/generate-set
// Drop this file into: functions/api/generate-set.js

const SYSTEM_PROMPT = `You generate word lists for a party game called Imposter, similar to Spyfall or Codenames Undercover. Given a theme phrase, produce exactly 50 short, well-known, easy-to-guess words or phrases related to that theme. Rules: each entry must be instantly recognizable to a general audience (think Eiffel Tower, Minecraft, Avengers level of fame, nothing obscure). Each entry must be 1-4 words. No duplicates. No numbering. No explanations. Respond ONLY with a JSON array of exactly 50 strings. No markdown. No backticks. No surrounding text. Start your response with [ and end with ].`;

const MAX_PHRASE_LENGTH = 80;
const MAX_RETRIES = 2; // try up to 3 times total before giving up

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

    // Retry loop — Gemini occasionally returns truncated or malformed JSON.
    // We try up to 3 times before giving up so the user doesn't have to.
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const words = await callGemini(env.GEMINI_API_KEY, phrase);
        if (!words || words.length < 10) {
          throw new Error('Not enough words returned');
        }
        return jsonResponse({ words });
      } catch (err) {
        lastError = err;
        console.warn(`Attempt ${attempt + 1} failed: ${err.message}`);
        // Short pause before retrying so we don't hammer the API
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }

    console.error('All attempts failed:', lastError?.message);
    return jsonResponse({
      error: 'Could not generate a set for that theme after several tries. Try a slightly different phrase.'
    }, 502);

  } catch (err) {
    console.error('generate-set error:', err);
    return jsonResponse({ error: 'Something went wrong generating that set.' }, 500);
  }
}

export async function onRequestGet() {
  return jsonResponse({ error: 'Use POST.' }, 405);
}

async function callGemini(apiKey, phrase) {
  // gemini-2.5-flash: fast, cheap, good at structured output
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

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
        temperature: 0.7,       // lower = more consistent JSON, fewer hallucinated prefixes
        maxOutputTokens: 2048,  // 50 items easily fits; this was the main cause of truncation
        responseMimeType: 'application/json', // tells Gemini to output raw JSON, no markdown wrapping
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

  // Strip any accidental markdown fences even with responseMimeType set,
  // since some model versions add them anyway
  let clean = text.trim();
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');

  // Find the JSON array even if there's stray text before or after it
  const arrayMatch = clean.match(/\[[\s\S]*\]/);
  if (!arrayMatch) throw new Error('No JSON array found in response');

  const parsed = JSON.parse(arrayMatch[0]);
  if (!Array.isArray(parsed)) throw new Error('Parsed value is not an array');

  return parsed
    .filter(x => typeof x === 'string' && x.trim().length > 0)
    .map(x => x.trim())
    .slice(0, 50);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }
  });
}
