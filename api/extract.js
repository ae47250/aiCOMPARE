/**
 * POST /api/extract
 * Body: { payload: string, modelId: string, effort?: string }
 * Returns: { ok, modelId, fields, usage:{in,out}, latencyMs, rawText?, error? }
 *
 * ONE model per request. The browser fires these in parallel so that
 * (a) no single invocation can hit the Vercel function timeout, and
 * (b) results stream into the matrix as each model returns.
 *
 * API keys are read from Vercel environment variables and never leave the server.
 */

export const config = { maxDuration: 60 };

/* ------------------------------------------------------------------ *
 * Providers                                                           *
 * Most vendors expose an OpenAI-compatible /chat/completions endpoint. *
 * Anthropic and Google need their own adapters.                        *
 * ------------------------------------------------------------------ */
const OPENAI_COMPAT = {
  openai:   { base: 'https://api.openai.com/v1',                                  env: 'OPENAI_API_KEY'    },
  xai:      { base: 'https://api.x.ai/v1',                                        env: 'XAI_API_KEY'       },
  deepseek: { base: 'https://api.deepseek.com/v1',                                env: 'DEEPSEEK_API_KEY'  },
  moonshot: { base: 'https://api.moonshot.ai/v1',                                 env: 'MOONSHOT_API_KEY'  },
  zhipu:    { base: 'https://open.bigmodel.cn/api/paas/v4',                       env: 'ZHIPU_API_KEY'     },
  alibaba:  { base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',     env: 'DASHSCOPE_API_KEY' },
};

/* ------------------------------------------------------------------ *
 * Model registry — the server is the source of truth for API IDs.     *
 * The browser sends only the short `id`; anything not in this map is   *
 * rejected. That keeps the endpoint from being used as an open proxy.  *
 * ------------------------------------------------------------------ */
const MODELS = {
  // Anthropic
  'sonnet-4-6':      { provider: 'anthropic', apiId: 'claude-sonnet-4-6',  effort: true  },
  'sonnet-5':        { provider: 'anthropic', apiId: 'claude-sonnet-5',    effort: true  },
  'opus-4-8':        { provider: 'anthropic', apiId: 'claude-opus-4-8',    effort: true  },
  'fable-5':         { provider: 'anthropic', apiId: 'claude-fable-5',     effort: true  },
  'haiku-4-5':       { provider: 'anthropic', apiId: 'claude-haiku-4-5',   effort: false },
  // Google
  'gemini-3-1-pro':  { provider: 'google', apiId: 'gemini-3.1-pro',        effort: true  },
  'gemini-3-5-flash':{ provider: 'google', apiId: 'gemini-3.5-flash',      effort: true  },
  'gemini-3-1-fl':   { provider: 'google', apiId: 'gemini-3.1-flash-lite', effort: true  },
  // OpenAI
  'gpt-5-6-sol':     { provider: 'openai', apiId: 'gpt-5.6-sol',           effort: true  },
  'gpt-5-6-terra':   { provider: 'openai', apiId: 'gpt-5.6-terra',         effort: true  },
  'gpt-5-6-luna':    { provider: 'openai', apiId: 'gpt-5.6-luna',          effort: true  },
  'gpt-5-4':         { provider: 'openai', apiId: 'gpt-5.4',               effort: true  },
  'gpt-5-5':         { provider: 'openai', apiId: 'gpt-5.5',               effort: true  },
  'gpt-5-4-mini':    { provider: 'openai', apiId: 'gpt-5.4-mini',          effort: true  },
  'gpt-5-4-nano':    { provider: 'openai', apiId: 'gpt-5.4-nano',          effort: false },
  'gpt-5-5-pro':     { provider: 'openai', apiId: 'gpt-5.5-pro',           effort: true  },
  'gpt-4-1':         { provider: 'openai', apiId: 'gpt-4.1',               effort: false },
  'o4-mini':         { provider: 'openai', apiId: 'o4-mini',               effort: true  },
  'gpt-4-1-nano':    { provider: 'openai', apiId: 'gpt-4.1-nano',          effort: false },
  // xAI
  'grok-4-5':        { provider: 'xai', apiId: 'grok-4.5',                 effort: true  },
  // Alibaba
  'qwen3-max':       { provider: 'alibaba', apiId: 'qwen3-max',            effort: false },
  'qwen-3-6-max':    { provider: 'alibaba', apiId: 'qwen3.6-max-preview',  effort: false },
  // Moonshot / Zhipu / DeepSeek
  'kimi-k2-6':       { provider: 'moonshot', apiId: 'kimi-k2.6',           effort: false },
  'glm-5-1':         { provider: 'zhipu',    apiId: 'glm-5.1',             effort: false },
  'deepseek-v4plus': { provider: 'deepseek', apiId: 'deepseek-chat',       effort: true  },
  'deepseek-v4-fl':  { provider: 'deepseek', apiId: 'deepseek-flash',      effort: false },
};

/* The 13 scored fields. Must stay in step with SCORED in the page. */
const FIELDS = ['name','addr','mail','ph','trees','size','sp','work','opts','prices','notes','sched','warn'];

const SYSTEM = [
  'You extract structured data from unstructured job notes.',
  'Return ONLY a JSON object. No prose, no markdown, no code fences.',
  'The object must have exactly these keys: ' + FIELDS.join(', ') + '.',
  'Every value is a string, or null if the note does not support a value.',
  'Never invent a value. If it is not in the note, the value is null.',
].join(' ');

const jsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(FIELDS.map(f => [f, { type: ['string', 'null'] }])),
  required: FIELDS,
};

/* ------------------------------------------------------------------ *
 * Adapters                                                            *
 * ------------------------------------------------------------------ */

async function callOpenAICompat(cfg, model, payload, effort) {
  const key = process.env[cfg.env];
  if (!key) throw new Error(`Missing environment variable ${cfg.env}`);

  const body = {
    model: model.apiId,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user',   content: payload },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'extraction', strict: true, schema: jsonSchema },
    },
    max_completion_tokens: 2048,
  };
  // Reasoning-effort control. Shape verified for OpenAI + xAI; harmless elsewhere
  // because unknown keys on OpenAI-compatible endpoints are generally ignored.
  if (model.effort && effort) body.reasoning_effort = effort;

  const r = await fetch(`${cfg.base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);

  return {
    text: j.choices?.[0]?.message?.content ?? '',
    usage: { in: j.usage?.prompt_tokens ?? 0, out: j.usage?.completion_tokens ?? 0 },
  };
}

async function callAnthropic(model, payload, effort) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Missing environment variable ANTHROPIC_API_KEY');

  const body = {
    model: model.apiId,
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: payload }],
    // Structured output via a forced tool call — more reliable than asking for
    // raw JSON, and it sidesteps the trailing-comma failure mode.
    tools: [{ name: 'record_extraction', description: 'Record the extracted fields.', input_schema: jsonSchema }],
    tool_choice: { type: 'tool', name: 'record_extraction' },
  };
  // Effort requires adaptive thinking on Opus 4.8 / Sonnet 5.
  if (model.effort && effort) {
    body.thinking = { type: 'adaptive' };
    body.effort = effort;
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);

  const toolUse = (j.content || []).find(b => b.type === 'tool_use');
  const text = toolUse
    ? JSON.stringify(toolUse.input)
    : (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

  return {
    text,
    usage: { in: j.usage?.input_tokens ?? 0, out: j.usage?.output_tokens ?? 0 },
  };
}

async function callGoogle(model, payload, effort) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('Missing environment variable GOOGLE_API_KEY');

  const gSchema = {
    type: 'OBJECT',
    properties: Object.fromEntries(FIELDS.map(f => [f, { type: 'STRING', nullable: true }])),
    required: FIELDS,
  };
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: payload }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: gSchema,
      maxOutputTokens: 2048,
    },
  };
  if (model.effort && effort) {
    body.generationConfig.thinkingConfig = { thinkingLevel: effort };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.apiId}:generateContent?key=${key}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);

  return {
    text: j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') ?? '',
    usage: {
      in:  j.usageMetadata?.promptTokenCount ?? 0,
      out: j.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Tolerant JSON parsing                                               *
 * Handles the two failure modes ExtractBench documents: code fences /  *
 * preamble, and trailing commas before a closing brace.                *
 * ------------------------------------------------------------------ */
function parseFields(text) {
  if (!text || !text.trim()) throw new Error('Empty response');

  let t = text.trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/,'')
    .trim();

  const first = t.indexOf('{');
  const last  = t.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('No JSON object in response');
  t = t.slice(first, last + 1).replace(/,(\s*[}\]])/g, '$1');

  const obj = JSON.parse(t);
  const out = {};
  for (const f of FIELDS) {
    const v = obj[f];
    out[f] = (v === null || v === undefined || v === '' || v === 'null') ? null : String(v).trim();
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Handler                                                             *
 * ------------------------------------------------------------------ */
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ ok: false, error: 'POST only' });

  const started = Date.now();
  try {
    const { payload, modelId, effort } = req.body || {};
    if (!payload || typeof payload !== 'string') throw new Error('Missing payload');
    if (payload.length > 40000) throw new Error('Payload too large');

    const model = MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    let result;
    if (model.provider === 'anthropic')   result = await callAnthropic(model, payload, effort);
    else if (model.provider === 'google') result = await callGoogle(model, payload, effort);
    else {
      const cfg = OPENAI_COMPAT[model.provider];
      if (!cfg) throw new Error(`No adapter for provider ${model.provider}`);
      result = await callOpenAICompat(cfg, model, payload, effort);
    }

    let fields, parseError = null;
    try { fields = parseFields(result.text); }
    catch (e) {
      parseError = e.message;
      fields = Object.fromEntries(FIELDS.map(f => [f, null]));
    }

    return res.status(200).json({
      ok: true,
      modelId,
      fields,
      usage: result.usage,
      latencyMs: Date.now() - started,
      parseError,
      rawText: parseError ? String(result.text).slice(0, 600) : undefined,
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      modelId: req.body?.modelId,
      error: String(err.message || err),
      latencyMs: Date.now() - started,
    });
  }
}
