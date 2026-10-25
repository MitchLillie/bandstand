#!/usr/bin/env node
// Early-warning monitor for BAND (band.us) web auth/signing changes.
//
// Fetches the public web client (no cookies, no login), extracts the code bandstand
// mirrors — request signing (makeMd/createMd/extractPath), the getKey bootstrap, token
// renewal, API host config, and the versions of the endpoints bandstand calls — and
// compares it to scripts/band-web-baseline.json.
//
//   node scripts/check-band-web.mjs              # check; exit 0 = nothing relevant changed
//   node scripts/check-band-web.mjs --update     # rewrite the baseline from live
//   node scripts/check-band-web.mjs --save DIR   # also save fetched files (for replay)
//   node scripts/check-band-web.mjs --from DIR   # replay saved files instead of fetching
//   node scripts/check-band-web.mjs --report F   # also write a Markdown report to F
//   node scripts/check-band-web.mjs --baseline F # use another baseline file
//   node scripts/check-band-web.mjs --rediscover # rescan all webpack chunks for endpoints
//
// Exit codes: 0 no relevant change · 1 relevant change · 2 fetch/structure error.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  alertsFingerprint,
  chooseChunkCover,
  codeItem,
  compareTracked,
  dataItem,
  findBootUrl,
  findEndpointVersions,
  locate,
  mergeVersions,
  parseApiHosts,
  parseBandstandEndpoints,
  parseChunkMap,
  parseGetKey,
  parseHtmlDomains,
} from "./band-web-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASELINE = join(HERE, "band-web-baseline.json");
const CLIENT_SRC = join(HERE, "..", "src", "client.ts");

const HOME_URL = "https://www.band.us/";
const GETKEY_URL = "https://auth.band.us/s/login/getKey";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0";
const CHUNK_SCAN_DELAY_MS = 250;

const { values: args } = parseArgs({
  options: {
    update: { type: "boolean", default: false },
    rediscover: { type: "boolean", default: false },
    save: { type: "string" },
    from: { type: "string" },
    report: { type: "string" },
    baseline: { type: "string", default: DEFAULT_BASELINE },
  },
});

class StructureError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(...a);

// ---------------------------------------------------------------------------------------
// Fetching (live, polite, cookie-less) or replay from a saved directory
// ---------------------------------------------------------------------------------------

let requestCount = 0;

async function fetchText(url, referer) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      requestCount++;
      const res = await fetch(url, {
        headers: {
          "user-agent": UA,
          accept: "*/*",
          "accept-language": "en-US,en;q=0.9",
          ...(referer ? { referer } : {}),
        },
        // Node's fetch has no cookie jar; we never set a Cookie header.
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

/** name -> text. `name` is the file name used by --save/--from. */
function makeSource() {
  const cache = new Map();
  return async (name, url, referer) => {
    if (cache.has(name)) return cache.get(name);
    let text;
    if (args.from) {
      try {
        text = readFileSync(join(args.from, name), "utf8");
      } catch {
        text = null;
      }
    } else {
      text = await fetchText(url, referer);
      if (args.save && text != null) {
        mkdirSync(dirname(join(args.save, name)), { recursive: true });
        writeFileSync(join(args.save, name), text);
      }
    }
    cache.set(name, text);
    return text;
  };
}

// ---------------------------------------------------------------------------------------
// Snapshot: everything relevant about the current BAND web client
// ---------------------------------------------------------------------------------------

async function snapshot(baseline) {
  const get = makeSource();
  const tracked = {};
  const notes = [];

  // 1. HTML shell -> boot.bundle.js (deploy id is informational only).
  const html = await get("home.html", HOME_URL);
  if (!html) throw new StructureError(`${HOME_URL} returned 404`);
  const boot = findBootUrl(html);
  if (!boot)
    throw new StructureError("www.band.us no longer references script/<id>/boot.bundle.js");
  tracked["html.domains"] = dataItem("notice", "www.band.us HTML", parseHtmlDomains(html));

  const bootSrc = await get("boot.bundle.js", boot.url, HOME_URL);
  if (!bootSrc) throw new StructureError(`boot bundle 404: ${boot.url}`);
  const B = "boot.bundle.js";
  const code = (key, level, file, src, loc) => {
    tracked[key] = codeItem(level, file, locate(src, loc));
  };
  code("boot.createMd", "alert", B, bootSrc, { kind: "prop", name: "createMd" });
  code("boot.extractPath", "alert", B, bootSrc, { kind: "prop", name: "extractPath" });
  code("boot.isInAppWebViewSignedUserWithToken", "alert", B, bootSrc, {
    kind: "prop",
    name: "isInAppWebViewSignedUserWithToken",
  });
  code("boot.getKeyLoader", "alert", B, bootSrc, { kind: "enclosing", needle: '"authCallBack_"' });
  code("boot.prepareAuth", "alert", B, bootSrc, { kind: "prop", name: "prepareAuth" });
  code("boot.mdHeaderHook", "alert", B, bootSrc, {
    kind: "enclosing",
    needle: 'setRequestHeader("md"',
  });
  code("boot.apiHostConfig", "alert", B, bootSrc, {
    kind: "object",
    needle: '"api.band.us":{DOMAIN:',
  });
  tracked["boot.apiHosts"] = dataItem("alert", B, parseApiHosts(bootSrc));

  // 2. getKey JSONP (anonymous) -> auth module path + bootstrap options.
  const ts = Date.now();
  const callback = `authCallBack_${ts}`;
  const getKey = await get("getKey.js", `${GETKEY_URL}?_t=${ts}&callback=${callback}`, HOME_URL);
  if (!getKey) throw new StructureError("getKey returned 404");
  const gk = parseGetKey(getKey);
  if (!gk.moduleBase) throw new StructureError("getKey response no longer contains Loader.path");
  if (!args.from && gk.callback !== callback) {
    notes.push(`getKey did not invoke our callback name (${callback}); got ${gk.callback}.`);
  }
  const optStart = gk.templateLines.findIndex((l) => l.includes("new BandWebAuthModule("));
  const optEnd = gk.templateLines.findIndex((l, i) => i > optStart && l.startsWith("}))"));
  tracked["getKey.bootstrapOptions"] = dataItem(
    "alert",
    "getKey",
    optStart >= 0 ? gk.templateLines.slice(optStart, optEnd + 1) : ["<NOT FOUND>"],
  );
  tracked["getKey.files"] = dataItem("alert", "getKey", gk.files);
  tracked["getKey.authModuleHash"] = dataItem("alert", "getKey", [gk.moduleHash]);
  tracked["getKey.template"] = dataItem("notice", "getKey", gk.templateLines);

  const modName = gk.files.find((f) => /BandWebAuthModule\.js$/.test(f)) ?? "BandWebAuthModule.js";
  const modSrc = await get("BandWebAuthModule.js", gk.moduleBase + modName, HOME_URL);
  if (!modSrc) throw new StructureError(`auth module 404: ${gk.moduleBase}${modName}`);
  const M = "BandWebAuthModule.js";
  const proto = (name) => ({ kind: "proto", cls: "BandWebAuthModule", name });
  code("auth.constructor", "alert", M, modSrc, { kind: "decl", name: "BandWebAuthModule" });
  code("auth.makeMd", "alert", M, modSrc, proto("makeMd"));
  code("auth.needTokenRenewal", "alert", M, modSrc, proto("needTokenRenewal"));
  code("auth.parseJwtToken", "alert", M, modSrc, proto("parseJwtToken"));
  code("auth.now", "alert", M, modSrc, proto("now"));
  // Whole module, informational: catches changes outside the functions above.
  tracked["auth.wholeModule"] = codeItem("notice", M, [modSrc]);

  // 3. Endpoint versions: boot + the smallest set of webpack chunks that mention them.
  const bandstand = parseBandstandEndpoints(readFileSync(CLIENT_SRC, "utf8"));
  const names = Object.keys(bandstand).sort();
  const chunkMap = parseChunkMap(bootSrc);
  if (!chunkMap) throw new StructureError("boot bundle no longer contains the webpack chunk map");
  const chunkBase = boot.url.replace(/boot\.bundle\.js$/, "");
  const chunkHits = new Map(); // id -> { id, size, names:Set, text }
  const fetchChunk = async (id) => {
    if (chunkHits.has(id)) return chunkHits.get(id);
    const hash = chunkMap[id];
    if (!hash) return null;
    const text = await get(`chunks/${id}.js`, `${chunkBase}${hash}.chunk.js`, HOME_URL);
    const hit = { id, size: text?.length ?? 0, names: new Set(), text: text ?? "" };
    for (const n of names) if (findEndpointVersions(hit.text, n).length) hit.names.add(n);
    chunkHits.set(id, hit);
    return hit;
  };
  const inBoot = new Set(names.filter((n) => findEndpointVersions(bootSrc, n).length));
  const covered = () => {
    const s = new Set(inBoot);
    for (const h of chunkHits.values()) for (const n of h.names) s.add(n);
    return s;
  };

  const remembered = args.rediscover ? [] : (baseline?.meta?.endpointChunks ?? []);
  for (const id of remembered) {
    await fetchChunk(id);
    if (!args.from) await sleep(CHUNK_SCAN_DELAY_MS);
  }
  let missing = names.filter((n) => !covered().has(n));
  if (missing.length || args.rediscover) {
    const why = args.rediscover ? "--rediscover" : `not found in remembered chunks: ${missing}`;
    log(`Scanning webpack chunks sequentially (${why})…`);
    for (const id of Object.keys(chunkMap)) {
      if (!args.rediscover && !missing.length) break;
      if (chunkHits.has(id)) continue;
      await fetchChunk(id);
      if (!args.from) await sleep(CHUNK_SCAN_DELAY_MS);
      missing = names.filter((n) => !covered().has(n));
    }
  }
  const neededFromChunks = names.filter((n) => !inBoot.has(n));
  const rememberedOk =
    remembered.length &&
    neededFromChunks.every((n) => remembered.some((id) => chunkHits.get(id)?.names.has(n)));
  const endpointChunks = rememberedOk
    ? remembered
    : chooseChunkCover([...chunkHits.values()], neededFromChunks);
  if (!rememberedOk && remembered.length) {
    notes.push(
      `Webpack chunk layout changed: endpoints now read from chunks [${endpointChunks}] ` +
        `(baseline had [${remembered}]). Run --update to remember the new set.`,
    );
  }
  const coverTexts = [bootSrc, ...endpointChunks.map((id) => chunkHits.get(id)?.text ?? "")];
  for (const n of names) {
    const web = mergeVersions(...coverTexts.map((t) => findEndpointVersions(t, n)));
    tracked[`endpoint.${n}`] = dataItem("alert", "web client", web.length ? web : ["<NOT FOUND>"]);
    for (const v of bandstand[n]) {
      if (web.length && !web.includes(v)) {
        notes.push(`bandstand calls /${v}/${n}, but the web client uses ${web.join(", ")}.`);
      }
    }
  }

  return {
    tracked,
    notes,
    meta: {
      deployId: boot.deployId,
      bootUrl: boot.url,
      authModuleBase: gk.moduleBase,
      getKeySecretKeyIssuedWithoutCookies: gk.secretKeyPresent,
      endpointChunks,
      endpointChunkHashes: Object.fromEntries(endpointChunks.map((id) => [id, chunkMap[id]])),
    },
  };
}

// ---------------------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------------------

function renderReport({ alerts, notices }, snap, baseline) {
  const out = [];
  const dep = snap.meta.deployId;
  const was = baseline?.meta?.deployId;
  out.push(
    alerts.length
      ? `## BAND web client: ${alerts.length} relevant change(s) detected`
      : "## BAND web client: no relevant changes",
  );
  out.push("");
  out.push(`- Deploy id: \`${dep}\`${was && was !== dep ? ` (baseline: \`${was}\`)` : ""}`);
  out.push(`- Auth module: ${snap.meta.authModuleBase}`);
  out.push(`- Baseline generated: ${baseline?.meta?.generatedAt ?? "n/a"}`);
  for (const a of alerts) {
    out.push("", `### ${a.title}`, "", "```diff", ...a.diff, "```");
  }
  const allNotes = [...snap.notes, ...notices];
  if (was && was !== dep) allNotes.unshift(`New BAND web deploy ${dep} (baseline ${was}).`);
  if (allNotes.length) {
    out.push("", "### Notes (not alerts)", "");
    for (const n of allNotes)
      out.push(n.includes("\n") ? `- ${n.replace(/\n/g, "\n    ")}` : `- ${n}`);
  }
  if (alerts.length) {
    out.push(
      "",
      "### What to do",
      "",
      "1. Check whether bandstand's signing (`src/crypto.ts`, `src/client.ts`) still matches.",
      "2. Once handled (or judged harmless): `npm run check:band-web -- --update` and commit",
      "   `scripts/band-web-baseline.json`. The watch issue can then be closed.",
      "",
      `<!-- band-web-diff-fingerprint: ${alertsFingerprint(alerts)} -->`,
    );
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

async function main() {
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(args.baseline, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    if (!args.update) {
      log(`No baseline at ${args.baseline}; run with --update first.`);
      return 2;
    }
  }

  const snap = await snapshot(baseline);
  log(`(${requestCount} HTTP request(s)${args.from ? `, replayed from ${args.from}` : ""})`);

  if (args.update) {
    const out = {
      $comment:
        "Generated by scripts/check-band-web.mjs --update. `hash` is sha256 of the " +
        "identifier-normalized code (or of the data lines); `source` is for humans.",
      meta: { generatedAt: new Date().toISOString(), ...snap.meta },
      tracked: snap.tracked,
    };
    writeFileSync(args.baseline, `${JSON.stringify(out, null, 2)}\n`);
    log(`Baseline written: ${args.baseline} (${Object.keys(snap.tracked).length} items)`);
    for (const n of snap.notes) log(`note: ${n}`);
    return 0;
  }

  const result = compareTracked(baseline.tracked, snap.tracked);
  const report = renderReport(result, snap, baseline);
  console.log(report);
  if (args.report) writeFileSync(args.report, `${report}\n`);
  return result.alerts.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    const kind = err instanceof StructureError ? "Structure changed" : "Error";
    const msg = `## BAND web watch: ${kind}\n\n\`\`\`\n${err.stack ?? err}\n\`\`\`\n`;
    console.log(msg);
    if (args.report) writeFileSync(args.report, msg);
    process.exit(2);
  },
);
