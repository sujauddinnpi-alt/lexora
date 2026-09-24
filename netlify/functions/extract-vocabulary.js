// Netlify serverless function: extracts a Key Vocabulary table (word +
// general Bangla meaning + contextual meaning) and an Important Phrases
// table (multi-word expressions + Bangla meaning) from an article, in the
// two-table study format the user wants. Uses Google's Gemini API (same
// free-tier key as the other AI features in this app).

const MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const MAX_CHARS = 8000;

const SYSTEM_PROMPT = `You are preparing vocabulary study material for a Bengali-speaking English learner who is reading the given article.

Produce exactly two lists as JSON, following this schema precisely (no extra keys, no commentary outside the JSON):

{
  "key_vocabulary": [
    {
      "term": "<the exact word or short phrase as it appears in the article>",
      "bn_meaning": "<its general Bangla (dictionary-style) meaning>",
      "contextual_meaning": "<in Bangla, what this word specifically means or refers to in THIS article's context>"
    }
  ],
  "phrases": [
    {
      "term": "<an exact multi-word phrase, collocation, or fixed expression as it appears in the article>",
      "bn_meaning": "<its Bangla meaning>"
    }
  ]
}

RULES:
1. Only include words and phrases that actually appear in the given article text (copy them exactly as written there).
2. For "key_vocabulary": include individual words (or short 2-3 word terms treated as one vocabulary item, e.g. "retail price") that a Bengali-speaking English learner would likely find genuinely useful or unfamiliar. Skip very common, everyday words (like "the", "government", "said", "also") that any learner would already know. Prioritize subject-specific, formal, or less common vocabulary.
3. For "phrases": include longer multi-word phrases, collocations, or idiomatic expressions from the article (e.g. "trade headwinds", "energy shock", "inflationary pressure", "align A with B") that are useful to learn as whole units, not single words.
4. Order both lists by the order the terms first appear in the article.
5. Limit "key_vocabulary" to at most 40 entries and "phrases" to at most 20 entries. If the article is short, include fewer -- do not repeat or pad.
6. Do not include duplicate terms within a list.
7. Output ONLY the JSON object above. No markdown code fences, no explanation before or after it.
8. All "bn_meaning" and "contextual_meaning" values must be written in natural, clear Bangla.`;

function jsonResponse(statusCode, body) {
  if (statusCode >= 400) {
    console.error('[function error]', statusCode, JSON.stringify(body).slice(0, 1000));
  }
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return jsonResponse(500, {
      error: 'server_not_configured',
      message: 'GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com, then add it in Netlify: Site settings -> Environment variables, and redeploy.'
    });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return jsonResponse(400, { error: 'No text provided' });
  }
  if (text.length > MAX_CHARS) {
    return jsonResponse(400, { error: `Text too long (max ${MAX_CHARS} characters)` });
  }

  const userPrompt =
    'Article text:\n' + text +
    '\n\nReturn ONLY the JSON object described in your instructions.';

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          maxOutputTokens: 8192,
          temperature: 0.2,
          thinkingConfig: { thinkingLevel: 'low' }
        }
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      const isQuota = resp.status === 429;
      return jsonResponse(502, {
        error: isQuota ? 'ai_quota_exceeded' : 'ai_service_error',
        status: resp.status,
        detail: errText.slice(0, 500)
      });
    }

    const data = await resp.json();
    const candidate = (data.candidates || [])[0];
    const parts = candidate && candidate.content && candidate.content.parts;
    let raw = Array.isArray(parts) && parts[0] ? (parts[0].text || '') : '';
    raw = raw.trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/, '')
      .replace(/```\s*$/, '');

    if (!raw) {
      return jsonResponse(502, {
        error: 'ai_empty_response',
        finishReason: candidate ? candidate.finishReason : null
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return jsonResponse(502, {
        error: 'ai_invalid_json',
        raw: raw.slice(0, 800)
      });
    }

    return jsonResponse(200, parsed);
  } catch (e) {
    return jsonResponse(500, { error: 'request_failed', detail: String(e).slice(0, 300) });
  }
};
