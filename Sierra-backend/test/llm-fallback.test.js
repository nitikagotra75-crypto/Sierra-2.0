const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

function server(handler) {
  return new Promise((res) => { const s = http.createServer(handler).listen(0, () => res(s)); });
}

test("llm: Gemini failure falls back to Groq; both failing reports every provider", async () => {
  const calls = [];
  const s = await server((q, r) => {
    let b = ""; q.on("data", (d) => (b += d));
    q.on("end", () => {
      r.setHeader("content-type", "application/json");
      if (q.url.includes("generativelanguage") || q.url.includes("/v1beta/")) {
        calls.push("gemini"); r.statusCode = 429; return r.end(JSON.stringify({ error: { message: "quota exceeded" } }));
      }
      calls.push("groq");
      if (q.headers.authorization !== "Bearer gk") { r.statusCode = 401; return r.end(JSON.stringify({ error: { message: "bad key" } })); }
      r.end(JSON.stringify({ choices: [{ message: { content: '{"from":"groq"}' } }] }));
    });
  });
  const port = s.address().port;
  const realFetch = global.fetch;
  global.fetch = (u, o) => realFetch(String(u).replace(/^https:\/\/[^/]+/, `http://127.0.0.1:${port}`), o);
  const saved = { ...process.env };
  process.env.GEMINI_API_KEY = "gem"; process.env.GROQ_API_KEY = "gk"; delete process.env.ANTHROPIC_API_KEY;
  const warn = console.warn; console.warn = () => {};
  try {
    delete require.cache[require.resolve("../src/agents/llm")];
    const llm = require("../src/agents/llm");
    assert.equal(llm.provider, "gemini -> groq");
    assert.deepEqual(await llm.askForJSON({ system: "s", prompt: "p" }), { from: "groq" });
    assert.deepEqual(calls, ["gemini", "groq"]);
    process.env.GROQ_API_KEY = "wrong";
    await assert.rejects(llm.askForJSON({ prompt: "p" }), (e) => e.code === "LLM_FAILED" && /gemini: .*429|quota/.test(e.message) && /groq: .*bad key/.test(e.message));
  } finally {
    console.warn = warn; global.fetch = realFetch; s.close();
    for (const k of ["GEMINI_API_KEY", "GROQ_API_KEY", "ANTHROPIC_API_KEY"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    delete require.cache[require.resolve("../src/agents/llm")];
  }
});
