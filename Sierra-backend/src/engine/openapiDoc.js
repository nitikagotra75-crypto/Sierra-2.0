/**
 * Builds an OpenAPI 3.0 document from the language-neutral ProjectSpec. Used by stacks whose framework cannot
 * derive the document from code (Flask, Django, Go net/http). The document is generated once, at generation
 * time, and shipped as a static file: if someone hand-edits routes later it must be regenerated or edited too.
 */
const JSON_TYPE = { string: "string", text: "string", int: "integer", float: "number", bool: "boolean", enum: "string" };

function fieldSchema(f) {
  const s = { type: JSON_TYPE[f.type] };
  if (f.type === "enum") s.enum = f.values;
  if (f.type === "string") s.maxLength = 255;
  if (f.default !== undefined) s.default = f.default;
  return s;
}

function buildOpenApi(spec) {
  const A = spec.needsAuth;
  const schemas = {
    Error: { type: "object", properties: { error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: { nullable: true } } } } },
  };
  const paths = {
    "/health": { get: { tags: ["meta"], summary: "Liveness probe", responses: { 200: { description: "OK" } } } },
    "/metrics": { get: { tags: ["meta"], summary: "Prometheus text metrics (per process)", responses: { 200: { description: "OK", content: { "text/plain": { schema: { type: "string" } } } } } } },
  };
  const errs = (...codes) => Object.fromEntries(codes.map((c) => [c, { description: { 401: "Unauthorized", 404: "Not found", 409: "Conflict", 422: "Validation error" }[c], content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }]));
  const sec = A ? { security: [{ bearer: [] }] } : {};
  const json = (ref) => ({ content: { "application/json": { schema: { $ref: `#/components/schemas/${ref}` } } } });
  if (A) {
    schemas.User = { type: "object", properties: { id: { type: "integer" }, email: { type: "string" }, name: { type: "string" }, created_at: { type: "string" } } };
    schemas.Register = { type: "object", required: ["email", "password"], properties: { email: { type: "string" }, name: { type: "string" }, password: { type: "string", minLength: 8, maxLength: 72 } } };
    schemas.Login = { type: "object", required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string" } } };
    schemas.Token = { type: "object", properties: { access_token: { type: "string" }, token_type: { type: "string" } } };
    paths["/api/auth/register"] = { post: { tags: ["auth"], summary: "Register", requestBody: { required: true, ...json("Register") }, responses: { 201: { description: "Created", ...json("User") }, ...errs(409, 422) } } };
    paths["/api/auth/login"] = { post: { tags: ["auth"], summary: "Log in", requestBody: { required: true, ...json("Login") }, responses: { 200: { description: "OK", ...json("Token") }, ...errs(401, 422) } } };
    paths["/api/auth/me"] = { get: { tags: ["auth"], summary: "Current user", ...sec, responses: { 200: { description: "OK", ...json("User") }, ...errs(401) } } };
  }
  for (const e of spec.entities) {
    const props = Object.fromEntries(e.fields.map((f) => [f.name, fieldSchema(f)]));
    const required = e.fields.filter((f) => f.required && f.default === undefined).map((f) => f.name);
    schemas[`${e.name}Create`] = { type: "object", properties: props, ...(required.length ? { required } : {}), additionalProperties: false };
    schemas[`${e.name}Update`] = { type: "object", properties: props, additionalProperties: false };
    schemas[e.name] = { type: "object", properties: { id: { type: "integer" }, ...props, ...(A ? { owner_id: { type: "integer" } } : {}), created_at: { type: "string" } } };
    const idParam = { name: "id", in: "path", required: true, schema: { type: "integer" } };
    const page = [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } }];
    const base = `/api/${e.plural}`;
    paths[base] = {
      get: { tags: [e.name], summary: `List ${e.plural}`, ...sec, parameters: page, responses: { 200: { description: "OK", content: { "application/json": { schema: { type: "array", items: { $ref: `#/components/schemas/${e.name}` } } } } }, ...errs(...(A ? [401, 422] : [422])) } },
      post: { tags: [e.name], summary: `Create ${e.name}`, ...sec, requestBody: { required: true, ...json(`${e.name}Create`) }, responses: { 201: { description: "Created", ...json(e.name) }, ...errs(...(A ? [401, 422] : [422])) } },
    };
    paths[`${base}/{id}`] = {
      get: { tags: [e.name], summary: `Get ${e.name}`, ...sec, parameters: [idParam], responses: { 200: { description: "OK", ...json(e.name) }, ...errs(...(A ? [401, 404] : [404])) } },
      put: { tags: [e.name], summary: `Update ${e.name}`, ...sec, parameters: [idParam], requestBody: { required: true, ...json(`${e.name}Update`) }, responses: { 200: { description: "OK", ...json(e.name) }, ...errs(...(A ? [401, 404, 422] : [404, 422])) } },
      delete: { tags: [e.name], summary: `Delete ${e.name}`, ...sec, parameters: [idParam], responses: { 204: { description: "Deleted" }, ...errs(...(A ? [401, 404] : [404])) } },
    };
  }
  return {
    openapi: "3.0.3",
    info: { title: spec.name, version: "1.0.0", description: "Generated by Sierra from the project spec." },
    paths,
    components: { schemas, ...(A ? { securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } } } : {}) },
  };
}

const openApiJson = (spec) => JSON.stringify(buildOpenApi(spec), null, 2) + "\n";

module.exports = { buildOpenApi, openApiJson };
