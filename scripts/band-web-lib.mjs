// Pure (offline) logic for scripts/check-band-web.mjs: a tiny JS lexer, function/object
// extraction from minified bundles, identifier-normalized hashing, and baseline diffing.
// No network, no fs — so it can be unit-tested (test/band-web-watch.test.mjs).

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------

const PUNCTUATORS = [
  ">>>=",
  "...",
  "===",
  "!==",
  "**=",
  "<<=",
  ">>=",
  ">>>",
  "&&=",
  "||=",
  "??=",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
  "**",
  "<<",
  ">>",
];

/** Keywords after which a `/` starts a regex literal rather than a division. */
const REGEX_AFTER_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const ID_START = /[A-Za-z_$\u0080-￿]/;
const ID_PART = /[\w$\u0080-￿]/;

function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.type === "punct") return ![")", "]", "}"].includes(prev.value);
  if (prev.type === "id") return REGEX_AFTER_KEYWORDS.has(prev.value);
  return false;
}

/**
 * Read one token starting at `pos` (skipping whitespace/comments).
 * Returns `null` at end of input. Throws on unterminated literals.
 */
function readToken(src, startPos, prev) {
  let pos = startPos;
  const n = src.length;
  for (;;) {
    while (pos < n && /\s/.test(src[pos])) pos++;
    if (pos >= n) return null;
    if (src.startsWith("//", pos)) {
      const nl = src.indexOf("\n", pos);
      pos = nl === -1 ? n : nl + 1;
      continue;
    }
    if (src.startsWith("/*", pos)) {
      const end = src.indexOf("*/", pos + 2);
      if (end === -1) throw new Error("unterminated comment");
      pos = end + 2;
      continue;
    }
    break;
  }
  const start = pos;
  const ch = src[pos];

  if (ch === '"' || ch === "'") {
    pos++;
    while (pos < n && src[pos] !== ch) {
      if (src[pos] === "\\") pos++;
      else if (src[pos] === "\n") throw new Error("unterminated string");
      pos++;
    }
    if (pos >= n) throw new Error("unterminated string");
    return { type: "str", value: src.slice(start, pos + 1), start, end: pos + 1 };
  }

  if (ch === "`") {
    pos++;
    while (pos < n && src[pos] !== "`") {
      if (src[pos] === "\\") pos += 2;
      else if (src.startsWith("${", pos)) pos = skipTemplateExpr(src, pos + 2);
      else pos++;
    }
    if (pos >= n) throw new Error("unterminated template");
    return { type: "tmpl", value: src.slice(start, pos + 1), start, end: pos + 1 };
  }

  if (ID_START.test(ch)) {
    pos++;
    while (pos < n && ID_PART.test(src[pos])) pos++;
    return { type: "id", value: src.slice(start, pos), start, end: pos };
  }

  if (/\d/.test(ch) || (ch === "." && /\d/.test(src[pos + 1] ?? ""))) {
    pos++;
    while (pos < n && /[\w.]/.test(src[pos])) pos++;
    return { type: "num", value: src.slice(start, pos), start, end: pos };
  }

  if (ch === "/" && regexAllowed(prev)) {
    pos++;
    let inClass = false;
    while (pos < n) {
      const c = src[pos];
      if (c === "\n") throw new Error("unterminated regex");
      if (c === "\\") pos += 2;
      else if (c === "[") {
        inClass = true;
        pos++;
      } else if (c === "]") {
        inClass = false;
        pos++;
      } else if (c === "/" && !inClass) break;
      else pos++;
    }
    if (pos >= n) throw new Error("unterminated regex");
    pos++;
    while (pos < n && /\w/.test(src[pos])) pos++;
    return { type: "regex", value: src.slice(start, pos), start, end: pos };
  }

  for (const p of PUNCTUATORS) {
    if (src.startsWith(p, pos)) return { type: "punct", value: p, start, end: pos + p.length };
  }
  return { type: "punct", value: ch, start, end: pos + 1 };
}

/** Skip a `${ ... }` template expression body; returns the index just past its `}`. */
function skipTemplateExpr(src, startPos) {
  let pos = startPos;
  let depth = 0;
  let prev = null;
  for (;;) {
    const tok = readToken(src, pos, prev);
    if (!tok) throw new Error("unterminated template expression");
    pos = tok.end;
    if (tok.value === "{") depth++;
    else if (tok.value === "}") {
      if (depth === 0) return pos;
      depth--;
    }
    prev = tok;
  }
}

/** Tokenize all of `src` (or from `start`, stopping after `limit` tokens). */
export function tokenize(src, start = 0) {
  const out = [];
  let pos = start;
  let prev = null;
  for (;;) {
    const tok = readToken(src, pos, prev);
    if (!tok) return out;
    out.push(tok);
    pos = tok.end;
    prev = tok;
  }
}

/**
 * Starting at `start`, read tokens until the brace opened by the first `{` (at paren
 * depth 0) closes. Returns the end index (exclusive).
 */
function scanToBlockEnd(src, start) {
  let pos = start;
  let prev = null;
  let parens = 0;
  let braces = 0;
  let opened = false;
  for (;;) {
    const tok = readToken(src, pos, prev);
    if (!tok) throw new Error("unexpected end of input");
    pos = tok.end;
    prev = tok;
    const v = tok.type === "punct" ? tok.value : null;
    if (v === "(") parens++;
    else if (v === ")") parens--;
    else if (v === "{") {
      if (parens === 0) opened = true;
      braces++;
    } else if (v === "}") {
      braces--;
      if (opened && braces === 0) return pos;
    }
  }
}

// ---------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------

/** Extract `function ... { ... }` starting at `fnIdx` (index of the `function` keyword). */
export function extractFunctionAt(src, fnIdx) {
  if (!src.startsWith("function", fnIdx)) throw new Error(`no 'function' at ${fnIdx}`);
  const end = scanToBlockEnd(src, fnIdx);
  return { start: fnIdx, end, text: src.slice(fnIdx, end) };
}

/** Extract a balanced `{ ... }` starting at `braceIdx`. */
export function extractObjectAt(src, braceIdx) {
  if (src[braceIdx] !== "{") throw new Error(`no '{' at ${braceIdx}`);
  const end = scanToBlockEnd(src, braceIdx);
  return { start: braceIdx, end, text: src.slice(braceIdx, end) };
}

function isWordAt(src, idx, word) {
  return (
    src.startsWith(word, idx) &&
    !ID_PART.test(src[idx - 1] ?? " ") &&
    !ID_PART.test(src[idx + word.length] ?? " ")
  );
}

/** The innermost `function` whose body contains `idx`, or null. */
export function enclosingFunction(src, idx, maxTries = 400) {
  let p = idx;
  for (let i = 0; i < maxTries; i++) {
    p = src.lastIndexOf("function", p - 1);
    if (p < 0) return null;
    if (!isWordAt(src, p, "function")) continue;
    try {
      const fn = extractFunctionAt(src, p);
      if (fn.end > idx) return fn;
    } catch {
      // `function` inside a string/comment, or a lexer misparse — try the next one out.
    }
  }
  return null;
}

/**
 * Find code by a locator. Returns an array of source snippets (possibly empty).
 *   { kind: "prop", name }        `name:function(...){...}` (object-literal method)
 *   { kind: "proto", cls, name }  `cls.prototype.name = function(...){...}`
 *   { kind: "decl", name }        `function name(...){...}`
 *   { kind: "enclosing", needle } innermost function containing `needle`
 *   { kind: "object", needle }    balanced `{...}` starting at the first `{` in `needle`
 */
export function locate(src, loc) {
  const out = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fromRegex = (re) => {
    for (const m of src.matchAll(re)) {
      const fnIdx = m.index + m[0].lastIndexOf("function");
      out.push(extractFunctionAt(src, fnIdx).text);
    }
  };
  switch (loc.kind) {
    case "prop":
      fromRegex(new RegExp(`(?<![\\w$.])${esc(loc.name)}\\s*:\\s*function\\b`, "g"));
      break;
    case "proto":
      fromRegex(
        new RegExp(`\\b${esc(loc.cls)}\\.prototype\\.${esc(loc.name)}\\s*=\\s*function\\b`, "g"),
      );
      break;
    case "decl":
      fromRegex(new RegExp(`\\bfunction\\s+${esc(loc.name)}\\s*\\(`, "g"));
      break;
    case "enclosing": {
      let i = src.indexOf(loc.needle);
      while (i !== -1) {
        const fn = enclosingFunction(src, i);
        if (fn && !out.includes(fn.text)) out.push(fn.text);
        i = src.indexOf(loc.needle, i + loc.needle.length);
      }
      break;
    }
    case "object": {
      let i = src.indexOf(loc.needle);
      while (i !== -1) {
        out.push(extractObjectAt(src, i + loc.needle.indexOf("{")).text);
        i = src.indexOf(loc.needle, i + loc.needle.length);
      }
      break;
    }
    default:
      throw new Error(`unknown locator kind ${loc.kind}`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------

const KEYWORDS = new Set(
  (
    "break case catch class const continue debugger default delete do else export extends " +
    "finally for function if import in instanceof let new return super switch this throw try " +
    "typeof var void while with yield await of null true false undefined async static get set " +
    "NaN Infinity arguments"
  ).split(" "),
);

/** Free globals a minifier never renames; keeping them makes the normalized form readable. */
const GLOBALS = new Set(
  (
    "window document location navigator console Date Math JSON Object Array String Number " +
    "Boolean RegExp Error Promise Symbol Map Set parseInt parseFloat isNaN encodeURIComponent " +
    "decodeURIComponent escape unescape atob btoa setTimeout clearTimeout setInterval " +
    "clearInterval bauth sjcl BandWebAuthModule IM whale"
  ).split(" "),
);

/**
 * Normalize JS source so that minifier renames and formatting don't matter:
 * comments/whitespace dropped, and every local identifier (anything that isn't a keyword,
 * a well-known global, a `.property`, or an object-literal key) replaced by `$0, $1, …`
 * in order of first appearance.
 */
export function normalizeJs(code) {
  const toks = tokenize(code);
  const names = new Map();
  const parts = toks.map((t, i) => {
    if (t.type !== "id") return t.value;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    if (KEYWORDS.has(t.value) || GLOBALS.has(t.value)) return t.value;
    if (prev && (prev.value === "." || prev.value === "?.")) return t.value;
    if (next?.value === ":" && prev && (prev.value === "{" || prev.value === ",")) return t.value;
    if (!names.has(t.value)) names.set(t.value, `$${names.size}`);
    return names.get(t.value);
  });
  return parts.join(" ");
}

/**
 * Human-readable form: comments dropped, whitespace collapsed, one statement per line
 * (breaks after `;`, `{`, `}`). Used for display and line diffs, never for hashing.
 */
export function prettyJs(code) {
  const toks = tokenize(code);
  const lines = [];
  let line = "";
  let depth = 0;
  toks.forEach((t, i) => {
    if (t.value === "}" && t.type === "punct") {
      if (line.trim()) lines.push("  ".repeat(depth) + line.trim());
      line = "";
      depth = Math.max(0, depth - 1);
    }
    line += t.value;
    const next = toks[i + 1];
    if (next && next.start > t.end) line += " ";
    if (t.type === "punct" && (t.value === ";" || t.value === "{" || t.value === "}")) {
      lines.push("  ".repeat(depth) + line.trim());
      line = "";
      if (t.value === "{") depth++;
    }
  });
  if (line.trim()) lines.push("  ".repeat(depth) + line.trim());
  return lines;
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** A tracked code item: hash of the normalized form + pretty source for humans. */
export function codeItem(level, file, snippets) {
  if (snippets.length === 0) return { level, file, hash: "NOT_FOUND", source: ["<NOT FOUND>"] };
  const normalized = snippets.map(normalizeJs).join("\n/* --- */\n");
  const source = snippets.flatMap((s, i) =>
    (i ? ["/* --- next match --- */"] : []).concat(prettyJs(s)),
  );
  return { level, file, hash: sha256(normalized), source };
}

/** A tracked data item (list of strings): hash of the exact lines. */
export function dataItem(level, file, lines) {
  return { level, file, hash: sha256(JSON.stringify(lines)), source: lines };
}

// ---------------------------------------------------------------------------------------
// Source-specific extractors
// ---------------------------------------------------------------------------------------

export const BOOT_RE = /https?:\/\/[^"'\s]+\/script\/(\d+)\/boot\.bundle\.js/;

export function findBootUrl(html) {
  const m = html.match(BOOT_RE);
  return m ? { url: m[0], deployId: m[1] } : null;
}

/** webpack chunk id -> content hash map from boot.bundle.js. */
export function parseChunkMap(boot) {
  const m = boot.match(/\{((?:\d+:"[0-9a-f]+",?)+)\}\[\w+\]\+"\.chunk\.js"/);
  if (!m) return null;
  return Object.fromEntries([...m[1].matchAll(/(\d+):"([0-9a-f]+)"/g)].map((x) => [x[1], x[2]]));
}

/** `window.fooDomain = "x"` assignments in the HTML shell. */
export function parseHtmlDomains(html) {
  return [...html.matchAll(/window\.(\w+Domain)\s*=\s*["']([^"']+)["']/g)]
    .map((m) => `${m[1]} = ${m[2]}`)
    .sort();
}

/** Host keys of the API config map in boot (`"api.band.us":{DOMAIN:window.apiDomain,…}`). */
export function parseApiHosts(boot) {
  return [
    ...new Set(
      [...boot.matchAll(/"([a-z0-9.-]+)":\{DOMAIN:([\w.]+)/g)].map((m) => `${m[1]} <- ${m[2]}`),
    ),
  ].sort();
}

/** Parse the getKey JSONP response. */
export function parseGetKey(text) {
  const path = text.match(/path:\s*['"](https?:\/\/[^'"]+\/auth\/js\/([0-9a-f]+)\/)['"]/);
  const srcList = text.match(/src:\s*\[([^\]]*)\]/);
  const files = srcList ? [...srcList[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : [];
  const callback = text.match(/\b(authCallBack_\d+)\s*\(/);
  const secret = text.match(/secretKey:\s*'([^']*)'/);
  const template = text
    .replace(/(secretKey:\s*)'[^']*'/g, "$1'<secret>'")
    .replace(/authCallBack_\d+/g, "authCallBack_<ts>")
    .replace(/\/auth\/js\/[0-9a-f]+\//g, "/auth/js/<hash>/")
    .replace(/\b\d{10,}\b/g, "<num>");
  const templateLines = template
    .split("\n")
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  return {
    moduleBase: path?.[1] ?? null,
    moduleHash: path?.[2] ?? null,
    files,
    callback: callback?.[1] ?? null,
    secretKeyPresent: !!secret?.[1],
    templateLines,
  };
}

/** `"/v2.0.0/create_schedule"`-style endpoint literals in bandstand's client source. */
export function parseBandstandEndpoints(clientSrc) {
  const out = {};
  for (const m of clientSrc.matchAll(/["'`]\/(v\d+(?:\.\d+)*)\/([a-z0-9_/]+)["'`]/g)) {
    const name = m[2];
    out[name] ??= [];
    if (!out[name].includes(m[1])) out[name].push(m[1]);
  }
  return out;
}

function compareVersions(a, b) {
  const pa = a.slice(1).split(".").map(Number);
  const pb = b.slice(1).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Versions under which `name` appears in `src` (e.g. ["v2.0.0", "v2.1.0"]). */
export function findEndpointVersions(src, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`/(v\\d+(?:\\.\\d+)*)/${esc}(?![A-Za-z0-9_/])`, "g");
  return [...new Set([...src.matchAll(re)].map((m) => m[1]))].sort(compareVersions);
}

export function mergeVersions(...lists) {
  return [...new Set(lists.flat())].sort(compareVersions);
}

/** Greedy smallest-first set cover: which chunks to fetch to see every endpoint. */
export function chooseChunkCover(chunkHits, needed) {
  // chunkHits: [{ id, size, names: Set<string> }]
  const remaining = new Set(needed);
  const chosen = [];
  const sorted = [...chunkHits].sort((a, b) => a.size - b.size);
  while (remaining.size) {
    let best = null;
    let bestScore = 0;
    for (const c of sorted) {
      const gain = [...c.names].filter((n) => remaining.has(n)).length;
      if (!gain) continue;
      const score = gain / Math.max(1, c.size);
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (!best) break;
    chosen.push(best.id);
    for (const n of best.names) remaining.delete(n);
  }
  return chosen.sort((a, b) => Number(a) - Number(b));
}

// ---------------------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------------------

/** Minimal LCS line diff with `context` lines around changes. Returns diff lines. */
export function lineDiff(a, b, context = 3) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push([" ", a[i++]]);
      j++;
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  const keep = ops.map(() => false);
  ops.forEach(([op], k) => {
    if (op === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) {
      keep[x] = true;
    }
  });
  const out = [];
  let skipped = false;
  ops.forEach(([op, line], k) => {
    if (!keep[k]) {
      if (!skipped) out.push("  …");
      skipped = true;
      return;
    }
    skipped = false;
    out.push(`${op} ${line}`);
  });
  return out;
}

/**
 * Compare current tracked items against the baseline.
 * Returns { alerts: [{key, title, diff}], notices: [string] }.
 */
export function compareTracked(baseline, current) {
  const alerts = [];
  const notices = [];
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort();
  const informational = [];
  for (const key of keys) {
    const was = baseline[key];
    const now = current[key];
    if (!was) {
      notices.push(`\`${key}\` is newly tracked (not in baseline) — run with --update.`);
      continue;
    }
    if (!now) {
      notices.push(`\`${key}\` is in the baseline but no longer tracked by the script.`);
      continue;
    }
    if (was.hash === now.hash) {
      if (JSON.stringify(was.source) !== JSON.stringify(now.source)) {
        notices.push(
          `\`${key}\`: cosmetic change only (identifiers renamed / formatting) — ignored.`,
        );
      }
      continue;
    }
    let diff = lineDiff(was.source, now.source);
    if (!diff.some((l) => l.startsWith("+ ") || l.startsWith("- "))) {
      diff = ["  (normalized hash changed but the displayed source is identical)"];
    }
    const entry = {
      key,
      file: now.file,
      title:
        now.hash === "NOT_FOUND"
          ? `${key}: no longer found in ${now.file}`
          : `${key} changed (${now.file})`,
      diff,
    };
    if (now.level === "alert" || was.level === "alert") alerts.push(entry);
    else informational.push(entry);
  }
  for (const e of informational) {
    // Don't repeat a diff an alert from the same file already shows.
    notices.push(
      alerts.some((a) => a.file === e.file)
        ? `\`${e.key}\` also changed (see alerts above for ${e.file}).`
        : `\`${e.key}\` changed (informational):\n${e.diff.join("\n")}`,
    );
  }
  return { alerts, notices };
}

/** Stable fingerprint of a set of alerts (for de-duplicating issue updates). */
export function alertsFingerprint(alerts) {
  return sha256(JSON.stringify(alerts.map((a) => [a.key, a.diff]))).slice(0, 16);
}
