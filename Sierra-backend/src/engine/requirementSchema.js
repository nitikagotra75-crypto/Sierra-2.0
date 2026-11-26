/**
 * Deterministic schema extraction from the requirement text (no LLM needed).
 *
 *   "Library API: books (title, author, isbn), members, loans. Members can register and log in."
 *   -> Book(title, author, isbn), Member(name, description), Loan(name, description)
 *
 * Understood: `noun (field, field type, other_field: int)` and plain nouns in the first
 * sentence's list. Field types come from an explicit type word (string|text|int|float|bool|
 * number|date...) or are inferred from the field name (price -> float, stock -> int, ...).
 * Everything produced goes through validateSchema(), so names/types are validated exactly
 * like LLM output; nothing is guessed beyond that and nouns without fields are reported.
 */
const STOP = new Set(["a", "an", "the", "and", "or", "with", "for", "to", "of", "in", "on", "api", "apis", "backend", "service", "app", "system", "rest", "crud", "endpoints", "endpoint", "login", "logout", "register", "signup", "auth", "authentication", "authorization", "jwt", "token", "password", "users", "user", "admin", "admins", "ke", "saath", "aur", "ka", "ki", "ko", "me", "mein", "kar", "sakein", "can", "should", "must", "also", "plus"]);
const TYPE_WORDS = { string: "string", str: "string", text: "text", int: "int", integer: "int", number: "float", float: "float", decimal: "float", double: "float", bool: "bool", boolean: "bool", date: "date", datetime: "date", timestamp: "date" };
const FLOAT_NAME = /(price|amount|cost|total|salary|rate|balance|fee|weight|height|rating|latitude|longitude|discount|tax)$/i;
const INT_NAME = /(quantity|qty|stock|count|age|year|number|capacity|pages|seats|size|duration|priority|level|views|likes|copies)$/i;
const BOOL_PREFIX = /^(is|has|can)[A-Z_]/;
const BOOL_NAME = /^(published|active|done|completed|paid|available|verified|archived|enabled|featured)$/i;
const TEXT_NAME = /^(description|content|body|notes|note|summary|details|bio|message|comment|address)$/i;
const DATE_NAME = /(date|_at|At|time)$/;

const camel = (s) => s.trim().replace(/[^A-Za-z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : "")).replace(/^[A-Z]/, (c) => c.toLowerCase());
const pascal = (s) => { const c = camel(s); return c.charAt(0).toUpperCase() + c.slice(1); };
function singular(w) {
  const l = w.toLowerCase();
  if (/(ies)$/.test(l) && l.length > 4) return w.slice(0, -3) + "y";
  if (/(sses|xes|ches|shes|zes)$/.test(l)) return w.slice(0, -2);
  if (/ss$|us$|is$/.test(l)) return w;
  if (/s$/.test(l)) return w.slice(0, -1);
  return w;
}

function inferType(name) {
  if (BOOL_PREFIX.test(name) || BOOL_NAME.test(name)) return "bool";
  if (TEXT_NAME.test(name)) return "text";
  if (FLOAT_NAME.test(name)) return "float";
  if (INT_NAME.test(name)) return "int";
  if (DATE_NAME.test(name) && !/^(update|candidate)$/i.test(name)) return "date";
  return "string";
}

function parseFields(inner) {
  const fields = [];
  for (const tok of inner.split(",").map((t) => t.trim()).filter(Boolean)) {
    const m = /^([A-Za-z_][A-Za-z0-9_ -]{0,40}?)(?:\s*[: ]\s*([A-Za-z]+))?$/.exec(tok);
    if (!m) return null;                                  // prose, not a field list
    let rawName = m[1].trim(), typeWord = m[2] && m[2].toLowerCase();
    if (!typeWord || !TYPE_WORDS[typeWord]) {             // "due date" / "full name" without a type word
      if (m[2]) rawName = `${rawName} ${m[2]}`.trim();
      typeWord = null;
    }
    if (rawName.split(/\s+/).length > 3) return null;
    const name = camel(rawName);
    if (!name) return null;
    fields.push({ name, type: typeWord ? TYPE_WORDS[typeWord] : inferType(rawName.includes("_") ? rawName : name), required: false });
  }
  return fields.length ? fields : null;
}

/** split on commas that are not inside parentheses */
function topLevel(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++; if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function schemaFromRequirement(requirement) {
  const text = String(requirement || "").replace(/\s+/g, " ").trim();
  const issues = [];
  const byName = new Map();
  const add = (word, fields) => {
    const name = pascal(singular(word));
    if (!name || STOP.has(word.toLowerCase()) || STOP.has(name.toLowerCase())) return;
    if (!byName.has(name) || (fields && !byName.get(name).explicit)) byName.set(name, { name, fields, explicit: !!fields });
  };
  // 1) every `noun (fields)` anywhere in the text
  const re = /([A-Za-z][A-Za-z-]*)\s*\(([^()]*)\)/g; let m;
  while ((m = re.exec(text))) {
    const fields = parseFields(m[2]);
    if (fields) add(m[1], fields);
  }
  // 2) plain nouns in the first list sentence ("API: books (..), members, loans.")
  const colon = text.indexOf(":");
  const firstSentence = (colon >= 0 ? text.slice(colon + 1) : text).split(/\.(?:\s|$)/)[0];
  const items = topLevel(firstSentence);
  if (colon >= 0) for (const item of items) {
    const it = item.replace(/\([^()]*\)/g, "").trim().replace(/^(and|aur|with)\s+/i, "");
    const words = it.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 2 || !words.every((w) => /^[A-Za-z-]+$/.test(w))) continue;
    if (words.some((w) => STOP.has(w.toLowerCase()))) continue;
    add(words.length === 2 ? words.join(" ") : words[0], null);
  }
  const entities = [];
  for (const e of byName.values()) {
    let fields = e.fields;
    if (!fields) {
      fields = [{ name: "name", type: "string", required: true }, { name: "description", type: "text", required: false }];
      issues.push(`${e.name}: no fields were listed in the requirement, generic name/description fields used`);
    } else {
      const first = fields.find((f) => f.type === "string" || f.type === "text") || fields[0];
      first.required = true;
    }
    entities.push({ name: e.name, fields });
  }
  return { entities, issues };
}

module.exports = { schemaFromRequirement };
