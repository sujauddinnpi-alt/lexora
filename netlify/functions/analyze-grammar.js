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
// Gemini to break each one down using a 6-part method:
//   1. Main Clause
//   2. Subordinate Clause(s)
//   3. Reduced Clause(s)
//   4. Phrase-by-Phrase Analysis
//   5. Complete Grammatical Tree
//   6. Key Corrections
// -- all as strict JSON that the front-end renders directly.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const MAX_SENTENCES_PER_REQUEST = 4;

const SYSTEM_PROMPT = `You are an expert English grammar teacher preparing IELTS-writing-level material for a Bengali-speaking English learner using a reading app called Lexora. The learner is specifically building a clause -> phrase -> word hierarchy skill.

For EACH sentence you are given, produce a grammatical breakdown using this exact 6-PART METHOD, and return it as JSON following EXACTLY this schema (no extra keys, no missing keys, no commentary outside the JSON):

{
  "sentences": [
    {
      "sentence": "<the exact original sentence, unchanged, including its ending punctuation>",

      "main_clause": {
        "text": "<the exact substring of the sentence that is the main (independent) clause>",
        "structure": "<a short structure label, e.g. 'Subject + Verb + Object + Degree/Amount', 'Subject + be + V-ing + Object'>",
        "breakdown": [
          { "part": "<exact word or phrase from the main clause>", "role_bn": "<its grammatical role, named in English with a short Bangla gloss, e.g. 'Subject (কর্তা)', 'Present Perfect Verb', 'Direct Object'>" }
        ],
        "meaning_bn": "<Bangla meaning of the main clause>"
      },

      "subordinate_clauses": [
        {
          "text": "<exact substring that is this subordinate clause>",
          "type_bn": "<clause type, e.g. 'Adverbial subordinate clause of reason', 'that-clause / noun clause', 'Conditional adverbial clause' -- English term, may add a short Bangla gloss>",
          "function_note_bn": "<in Bangla, what this clause is doing in the sentence -- e.g. explaining why, when, or under what condition>",
          "meaning_bn": "<Bangla meaning of this clause>"
        }
      ],

      "reduced_clauses": [
        {
          "phrase": "<the exact reduced phrase/construction from the sentence, e.g. 'effective from midnight on September 20', 'driven by the international energy situation'>",
          "full_form": "<the unreduced full clause this could be expanded into, e.g. 'which is driven by the international energy situation'>",
          "modifies": "<the exact word or phrase in the sentence that this reduced clause modifies>",
          "meaning_bn": "<Bangla meaning of this reduced clause>"
        }
      ],

      "phrases": [
        {
          "phrase": "<an exact bracket-worthy phrase from the sentence>",
          "category": "<phrase category + function, e.g. 'NP + Subject', 'VP + Predicate', 'PP + Cause adjunct', 'Past participial phrase / reduced relative clause', 'Infinitive phrase (purpose)'>",
          "internal_breakdown_bn": "<if useful, break the phrase into its own parts in Bangla, e.g. 'the -> Determiner, retail -> Adjective, prices -> Head noun'; empty string if not needed>",
          "meaning_bn": "<Bangla meaning of this phrase>"
        }
      ],

      "grammatical_tree": [
        {
          "phrase": "<an exact phrase from the sentence, covering the sentence from start to end across all tree entries together>",
          "category_function_bn": "<its grammatical category and function, e.g. 'NP + Subject', 'PP + modifier of \\"prices\\"', 'Reduced construction + temporal information'>",
          "meaning_bn": "<Bangla meaning of this piece>"
        }
      ],

      "key_corrections": [
        {
          "issue": "<the exact problematic word/phrase from the original sentence, or a short label for the issue>",
          "correction": "<the corrected/more natural form>",
          "explanation_bn": "<in Bangla, why this is a problem and why the correction is better>"
        }
      ]
    }
  ]
}

GUIDANCE FOR EACH PART (mirror this teaching style closely -- it is modeled on a real Bangla-medium IELTS grammar class):
1. Main Clause: identify the single independent main clause, its structure pattern, a word/phrase-level breakdown of its parts with grammatical roles, and its Bangla meaning.
2. Subordinate Clause(s): list every subordinate/adverbial/noun/relative finite clause (with an explicit subject + finite verb). If genuinely none exist, return an empty array -- do not invent one.
3. Reduced Clause(s): list every non-finite / reduced construction (participial phrases, reduced relative clauses, absolute constructions) that could be expanded into a full clause. For each, give its full unreduced form and what it modifies. If none exist, return an empty array.
4. Phrase-by-Phrase Analysis: break the sentence into its key phrases (NP, VP, AdjP, AdvP, PP, participial phrase, infinitive phrase, etc.), each with its function and, where it adds clarity, an internal word-level breakdown.
5. Complete Grammatical Tree: give a full ordered list of bracketed phrase entries that together cover the entire sentence from start to end (like a flattened parse tree), each with its category + function and Bangla meaning.
6. Key Corrections: only include entries where the original sentence has a genuine grammatical or stylistic issue (awkward phrasing, missing article, non-native phrasing, unclear reference, etc.) that a careful editor would flag. If the sentence is clean, return an empty array -- do not invent corrections just to fill the list.

CRITICAL RULES:
1. Every "text" and "phrase" field must be copied character-for-character from the original sentence -- do not paraphrase the English.
2. Do not force content into a part that doesn't apply (empty arrays are correct and expected for subordinate_clauses, reduced_clauses, and key_corrections when a sentence doesn't have them).
3. Output ONLY the JSON object above. No markdown code fences, no explanation before or after it.
4. Every "*_bn" field must be written in natural, clear Bangla, matching the teaching tone of a Bangla-medium IELTS grammar class (mixing in English grammar terms is fine and expected).`;

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
    'Sentences (JSON array, analyze each one independently using the 6-part method):\n' +
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
