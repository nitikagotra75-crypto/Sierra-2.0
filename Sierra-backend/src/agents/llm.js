// LLM access with automatic fallback. Providers are tried in this order, using
// whichever keys are set:  Gemini (GEMINI_API_KEY) -> Groq (GROQ_API_KEY) -> Anthropic (ANTHROPIC_API_KEY).
// If a provider errors (quota, outage, bad model name, unparsable output) the next one is tried.
// Gemini and Groq are called over plain REST, so no extra dependency is needed.
const env = () => process.env;
const geminiModel = () => env().SIERRA_LLM_MODEL || "gemini-2.5-flash";
const groqModel = () => env().GROQ_MODEL || "llama-3.3-70b-versatile";

function parseJSON(text) {
  const cleaned = String(text).replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

async function post(url, headers, body, label) {
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const e = new Error(`${label} API error ${resp.status}: ${(data.error && data.error.message) || "request failed"}`);
    e.status = resp.status;
    throw e;
  }
  return data;
}

const providers = [
  {
    name: "gemini",
    key: () => env().GEMINI_API_KEY || env().GOOGLE_API_KEY,
    async ask({ system, prompt, maxTokens }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel())}:generateContent`;
      const data = await post(url, { "x-goog-api-key": this.key() }, {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json" },
      }, "Gemini");
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const text = parts.map((p) => p.text || "").join("\n");
      if (!text) throw new Error("Gemini returned no text (blocked or empty response)");
      return text;
    },
  },
  {
    name: "groq",
    key: () => env().GROQ_API_KEY,
    async ask({ system, prompt, maxTokens }) {
      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });
      const data = await post("https://api.groq.com/openai/v1/chat/completions", { Authorization: `Bearer ${this.key()}` }, {
        model: groqModel(), messages, max_tokens: maxTokens, response_format: { type: "json_object" },
      }, "Groq");
      const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error("Groq returned no text");
      return text;
    },
  },
  {
    name: "anthropic",
    key: () => env().ANTHROPIC_API_KEY,
    async ask({ system, prompt, maxTokens }) {
      const Anthropic = require("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: this.key() });
      const resp = await client.messages.create({
        model: env().ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: maxTokens, system, messages: [{ role: "user", content: prompt }],
      });
      return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    },
  },
];

const configured = () => providers.filter((p) => p.key());

async function askForJSON({ system, prompt, maxTokens = 4096 }) {
  const list = configured();
  if (!list.length) {
    const err = new Error("NO_LLM_KEY");
    err.code = "NO_LLM_KEY";
    throw err;
  }
  const errors = [];
  for (const p of list) {
    try {
      return parseJSON(await p.ask({ system, prompt, maxTokens }));
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
      console.warn(`[llm] ${p.name} failed, ${list.indexOf(p) < list.length - 1 ? "trying next provider" : "no more providers"}: ${e.message}`);
    }
  }
  const err = new Error(`All LLM providers failed - ${errors.join(" | ")}`);
  err.code = "LLM_FAILED";
  throw err;
}

module.exports = {
  askForJSON,
  hasLLM: configured().length > 0,
  get provider() { const c = configured(); return c.length ? c.map((p) => p.name).join(" -> ") : null; },
};
