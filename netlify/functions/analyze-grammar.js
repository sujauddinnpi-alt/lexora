// Netlify serverless function: deep grammar breakdown for the Article Reader.
//
// Uses Google's Gemini API (free tier) instead of a paid provider, so this
// feature can run at $0 cost. Get a free key at https://aistudio.google.com
// (Google AI Studio -> "Get API key") -- no credit card required as long as
// you stay on the free usage tier. Set it in Netlify: Site settings ->
// Environment variables -> GEMINI_API_KEY. The key never reaches the browser.
//
// Heads up: on Gemini's free tier, Google may use the prompts/responses sent
// through this function to improve their products (this is not the case on
// their paid tier). Don't paste anything private/sensitive into the article
// box if that matters to you.
//
// The client sends a small batch of plain-text sentences; this function asks
// Gemini to break each one down using a 5-group method:
//   1. Core Sentence & Clause Structure
//   2. Phrase & Internal Structure
//   3. Non-finite & Reduced Structures
//   4. Modifier & Complement Relationships
//   5. Word-Level & Final Summary
// -- all as strict JSON that the front-end renders directly.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const MAX_SENTENCES_PER_REQUEST = 4;

const SYSTEM_PROMPT = `You are an expert English grammar teacher preparing material for a Bengali-speaking English learner using a reading app called Lexora.

For EACH sentence you are given, produce a grammatical breakdown using this exact 5-GROUP METHOD, and return it as JSON following EXACTLY this schema (no extra keys, no missing keys, no commentary outside the JSON):

{
  "sentences": [
    {
      "sentence": "<the exact original sentence, unchanged, including its ending punctuation>",
      "sentence_type_bn": "<the sentence type in Bangla, e.g. 'Simple Sentence', 'Compound Sentence', 'Complex Sentence', or 'Compound-Complex Sentence' -- keep the English grammar term but you may add a short Bangla gloss in parentheses>",
      "pattern": "<the core clause pattern using short labels, e.g. 'S + Modal + V + Adverbial' or 'S + V + O + Object Complement'>",

      "group1_clauses": [
        {
          "label_bn": "<Bangla label for this clause, e.g. 'মূল clause', 'Subordinate clause (while-clause)', 'Relative clause'>",
          "text": "<the exact substring of the sentence that forms this clause>",
          "subject": "<the subject of this clause, or empty string if not applicable>",
          "verb": "<the verb/verb phrase of this clause>",
          "object": "<the object of this clause, or 'কেই' (none) if there isn't one>",
          "note_bn": "<1 sentence in Bangla explaining this clause's role in the sentence>"
        }
      ],

      "group2_phrases": [
        {
          "text": "<the exact phrase text from the sentence>",
          "type_bn": "<the phrase type, e.g. 'Prepositional Phrase', 'Noun Phrase', 'Verb Phrase', 'Adjective Phrase', 'Adverb Phrase'>",
          "breakdown_bn": "<break the phrase into its parts in Bangla, e.g. 'the = determiner, digital = adjective, age = noun', matching the style of a Bangla grammar class>"
        }
      ],

      "group3_nonfinite": [
        {
          "text": "<the exact non-finite or reduced structure text, e.g. 'to spread rapidly', 'sharing it', 'supporting it'>",
          "type_bn": "<the type, e.g. 'to-infinitive', 'present participle', 'gerund', 'reduced relative clause', 'past participle used adjectivally'>",
          "note_bn": "<a short Bangla explanation of what this structure does and, where useful, its full/unreduced form, e.g. 'পূর্ণ form: evidence that supports it'>"
        }
      ],

      "group4_modifiers": [
        {
          "modifier": "<the modifying word or phrase>",
          "target": "<the word or phrase it modifies or complements>",
          "note_bn": "<optional short Bangla note if the relationship needs explanation, else empty string>"
        }
      ],

      "group5_words": [
        {
          "word": "<a grammatically important word from the sentence>",
          "pos_bn": "<its part of speech / grammatical role, e.g. 'uncountable noun', 'modal auxiliary', 'subordinating conjunction', 'present participle'>"
        }
      ],

      "meaning_bn": "<a natural, fluent Bangla translation/summary of the whole sentence -- this is the 'Final Summary' part of Group 5>"
    }
  ]
}

GUIDANCE FOR EACH GROUP (follow this teaching style closely -- it mirrors a Bangla grammar class):
- Group 1 (Core Sentence & Clause Structure): Identify every clause (main and subordinate/relative/etc.), give Subject/Verb/Object for each, state the overall sentence type, and give the core pattern.
- Group 2 (Phrase & Internal Structure): Pick out the sentence's key phrases (prepositional, noun, verb, adjective, adverb phrases) and break each into its internal parts (determiner/adjective/noun, preposition/noun phrase, etc.).
- Group 3 (Non-finite & Reduced Structures): Find every to-infinitive, gerund, present/past participle, and reduced relative clause. If a sentence genuinely has none, return an empty array for group3_nonfinite.
- Group 4 (Modifier & Complement Relationships): For each important modifier, state what it modifies or completes, in modifier -> target pairs (e.g. "digital -> age", "across the world -> travel"). Include article and preposition choices here where they matter (e.g. why "the" attaches to a noun, why a preposition follows a particular verb) if not already covered elsewhere.
- Group 5 (Word-Level & Final Summary): List the grammatically important words with their part of speech / role, then give the sentence's overall Bangla meaning in meaning_bn.

CRITICAL RULES:
1. Follow the schema field names and structure exactly.
2. Every "text" field must be copied character-for-character from the original sentence (or clause) -- do not paraphrase the English.
3. If a group has nothing meaningful to show for a given sentence (most commonly group3_nonfinite), return an empty array for it rather than inventing content.
4. Output ONLY the JSON object above. No markdown code fences, no explanation before or after it.
5. All *_bn fields must be written in natural, clear Bangla, matching the teaching tone of a Bangla-medium grammar class (mixing in English grammar terms is fine and expected, exactly as a Bangla grammar teacher would).`;

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

  const sentences = Array.isArray(payload.sentences)
    ? payload.sentences.filter((s) => typeof s === 'string' && s.trim().length > 0)
    : [];

  if (!sentences.length) {
    return jsonResponse(400, { error: 'No sentences provided' });
  }
  if (sentences.length > MAX_SENTENCES_PER_REQUEST) {
    return jsonResponse(400, { error: `Too many sentences in one request (max ${MAX_SENTENCES_PER_REQUEST})` });
  }

  const userPrompt =
    'Sentences (JSON array, analyze each one independently using the 5-group method):\n' +
    JSON.stringify(sentences) +
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
