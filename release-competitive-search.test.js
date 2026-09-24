import assert from "node:assert/strict";
import test from "node:test";
import { createCompetitiveSearchHandler, verifiedCompetitiveResults } from "./release-competitive-search.js";

const source = { url: "https://salon.example/servicios" };
const validData = {
  output: [
    { type: "web_search_call", action: { sources: [source] } },
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results: [
      { title: "Salon en Pueblo Libre", snippet: "Peluquería en Pueblo Libre", url: source.url },
      { title: "Inventado", snippet: "Sin evidencia", url: "https://inventado.example/" },
      { title: "Sitio propio", snippet: "No es competencia", url: "https://medalisalon.com/" }
    ] }) }] }
  ], usage: { input_tokens: 100, output_tokens: 50 }
};

function mockResponse() {
  return { statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

test("only URLs returned by web search sources become candidates", () => {
  const result = verifiedCompetitiveResults(validData, "medalisalon.com");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, source.url);
  assert.equal(result.searchCalls, 1);
});

test("no actual tool call is not treated as a completed search", () => {
  assert.equal(verifiedCompetitiveResults({ output: [{ type: "message", content: [{ type: "output_text", text: '{"results":[]}' }] }] }).error, "search_not_run");
});

test("missing sources and fabricated candidates remain unavailable evidence", () => {
  const withoutSources = structuredClone(validData);
  withoutSources.output[0].action.sources = [];
  assert.equal(verifiedCompetitiveResults(withoutSources).error, "search_no_sources");
  const fabricatedOnly = structuredClone(validData);
  fabricatedOnly.output[1].content[0].text = '{"results":[{"title":"Inventado","url":"https://inventado.example/"}]}';
  assert.equal(verifiedCompetitiveResults(fabricatedOnly).error, "search_unverified_results");
});

test("web-first and social fallback never mix source types", () => {
  const mixed = structuredClone(validData);
  mixed.output[0].action.sources.push({ url: "https://www.instagram.com/salonvecino/" });
  mixed.output[1].content[0].text = JSON.stringify({ results: [
    { title: "Salon con web", url: source.url },
    { title: "Salon en Instagram", url: "https://www.instagram.com/salonvecino/" }
  ] });
  assert.equal(verifiedCompetitiveResults(mixed, "medalisalon.com", "web").results[0].url, source.url);
  assert.equal(verifiedCompetitiveResults(mixed, "medalisalon.com", "web").results.length, 1);
  assert.equal(verifiedCompetitiveResults(mixed, "medalisalon.com", "social").results[0].domain, "instagram.com");
  assert.equal(verifiedCompetitiveResults(mixed, "medalisalon.com", "social").results.length, 1);
});

test("authenticated search uses existing key, bounds calls, and caches identical requests", async () => {
  let calls = 0;
  const handler = createCompetitiveSearchHandler({ apiKey: "test-key", fetchImpl: async (_url, options) => {
    calls++;
    assert.equal(options.headers.Authorization, "Bearer test-key");
    const body = JSON.parse(options.body);
    assert.equal(body.tool_choice, "required");
    assert.equal(body.max_tool_calls, 3);
    assert.match(body.instructions, /actividad principal/);
    assert.match(body.instructions, /hasta tres negocios distintos/);
    assert.equal(body.input.includes("Pueblo Libre"), true);
    return { ok: true, json: async () => validData };
  } });
  const req = { auth: { userId: "user-1" }, body: { queries: ["peluqueria Pueblo Libre"], siteDomain: "medalisalon.com" } };
  const first = mockResponse();
  await handler(req, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.results.length, 1);
  const second = mockResponse();
  await handler(req, second);
  assert.equal(calls, 1);
  assert.deepEqual(second.body, first.body);
});

test("unauthenticated requests and invalid domains do not call the provider", async () => {
  const handler = createCompetitiveSearchHandler({ apiKey: "test-key", fetchImpl: () => { throw new Error("must not call"); } });
  const unauthorized = mockResponse();
  await handler({ body: { queries: ["x"], siteDomain: "a.com" } }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  const invalid = mockResponse();
  await handler({ auth: { userId: "user-1" }, body: { queries: ["x"], siteDomain: "localhost" } }, invalid);
  assert.equal(invalid.statusCode, 400);
});

test("provider errors do not become invented results", async () => {
  const handler = createCompetitiveSearchHandler({ apiKey: "test-key", fetchImpl: async () => ({ ok: false, status: 429 }) });
  const response = mockResponse();
  await handler({ auth: { userId: "user-1" }, body: { queries: ["peluqueria Pueblo Libre"], siteDomain: "medalisalon.com" } }, response);
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.results, undefined);
});
