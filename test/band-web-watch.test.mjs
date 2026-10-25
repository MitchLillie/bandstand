// Offline tests for the BAND web-change monitor's pure logic (scripts/band-web-lib.mjs).
import { describe, expect, it } from "vitest";
import {
  chooseChunkCover,
  codeItem,
  compareTracked,
  dataItem,
  findEndpointVersions,
  lineDiff,
  locate,
  normalizeJs,
  parseGetKey,
} from "../scripts/band-web-lib.mjs";

// Shape of BandWebAuthModule.prototype.makeMd after the 2026-10-21 deploy.
const MAKE_MD_JWT = `
function BandWebAuthModule(info) { this.secretKey = info.secretKey; this.isJwtType = info.isJwtType; }
BandWebAuthModule.prototype.makeMd = function(source, isApp) {
  try {
    if (typeof isApp == 'undefined' || isApp == false) {
      if (this.isJwtType == true) {
        var hmac = new bauth.sjcl.misc.hmac(bauth.sjcl.codec.base64url.toBits(this.secretKey))
      } else {
        var hmac = new bauth.sjcl.misc.hmac(bauth.sjcl.codec.utf8String.toBits(this.secretKey));
      }
    } else {
      var hmac = new bauth.sjcl.misc.hmac(bauth.sjcl.codec.base64url.toBits(this.secretKey))
    }
    return { md: bauth.sjcl.codec.base64.fromBits(hmac.encrypt(source)) }; // comment
  } catch (e) { throw e }
}
BandWebAuthModule.prototype.now = function() { return 1; }
`;

const makeMdLoc = { kind: "proto", cls: "BandWebAuthModule", name: "makeMd" };
const makeMdItem = (src) => codeItem("alert", "BandWebAuthModule.js", locate(src, makeMdLoc));

describe("normalizeJs", () => {
  it("ignores local identifier renames, whitespace and comments", () => {
    const a = 'function(e){var t=o.extractPath(e);/* x */return t.replace(/\'/gi,"%27")}';
    const b =
      'function (x) {\n  var q = z.extractPath(x); // y\n  return q.replace(/\'/gi, "%27")\n}';
    expect(normalizeJs(a)).toBe(normalizeJs(b));
  });

  it("keeps property names and object keys significant", () => {
    expect(normalizeJs("function(e){return e.foo}")).not.toBe(
      normalizeJs("function(e){return e.bar}"),
    );
    expect(normalizeJs("function(){return{md:1}}")).not.toBe(
      normalizeJs("function(){return{mx:1}}"),
    );
  });

  it("lexes regex literals containing quotes and slashes", () => {
    const src =
      'x={extractPath:function(e){return e.replace(/^.*?:\\/\\//g,"").replace(/^[^/]+/g,"")}}';
    const [fn] = locate(src, { kind: "prop", name: "extractPath" });
    expect(fn).toBe('function(e){return e.replace(/^.*?:\\/\\//g,"").replace(/^[^/]+/g,"")}');
  });
});

describe("locate", () => {
  it("finds object-literal methods in minified code", () => {
    const src =
      'a={makeNowTime:function(){return 1},createMd:function(e){if(!c)return null;return{a:"}"}.a}}';
    expect(locate(src, { kind: "prop", name: "createMd" })).toEqual([
      'function(e){if(!c)return null;return{a:"}"}.a}',
    ]);
  });

  it("finds the innermost enclosing function of a needle", () => {
    const src =
      'function outer(){var z=1;!function e(t){var d="authCallBack_"+t;window[d]=function(x){}}();return z}';
    const [fn] = locate(src, { kind: "enclosing", needle: '"authCallBack_"' });
    expect(fn).toBe('function e(t){var d="authCallBack_"+t;window[d]=function(x){}}');
  });

  it("extracts prototype methods and constructors", () => {
    expect(locate(MAKE_MD_JWT, makeMdLoc)).toHaveLength(1);
    expect(locate(MAKE_MD_JWT, { kind: "decl", name: "BandWebAuthModule" })[0]).toContain(
      "this.isJwtType = info.isJwtType",
    );
  });
});

describe("compareTracked", () => {
  const baseline = { "auth.makeMd": makeMdItem(MAKE_MD_JWT) };

  it("flags the 2026-10-21-style key-encoding change (base64url <-> utf8)", () => {
    const reverted = MAKE_MD_JWT.replace(
      "base64url.toBits(this.secretKey))\n      } else",
      "utf8String.toBits(this.secretKey))\n      } else",
    );
    expect(reverted).not.toBe(MAKE_MD_JWT);
    const { alerts } = compareTracked(baseline, { "auth.makeMd": makeMdItem(reverted) });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].diff.join("\n")).toMatch(/^- .*base64url/m);
    expect(alerts[0].diff.join("\n")).toMatch(/^\+ .*utf8String/m);
  });

  it("treats a minifier rename as cosmetic (notice, no alert)", () => {
    const renamed = MAKE_MD_JWT.replaceAll("var hmac", "var h")
      .replace("hmac.encrypt(source)", "h.encrypt(s)")
      .replace("function(source,", "function(s,");
    expect(renamed).not.toBe(MAKE_MD_JWT);
    const { alerts, notices } = compareTracked(baseline, { "auth.makeMd": makeMdItem(renamed) });
    expect(alerts).toEqual([]);
    expect(notices.join()).toMatch(/cosmetic/);
  });

  it("alerts when a tracked function disappears", () => {
    const { alerts } = compareTracked(baseline, { "auth.makeMd": makeMdItem("var x = 1;") });
    expect(alerts[0].title).toMatch(/no longer found/);
  });

  it("does not alert on notice-level items", () => {
    const { alerts, notices } = compareTracked(
      { "html.domains": dataItem("notice", "html", ["apiDomain = api-us.band.us"]) },
      { "html.domains": dataItem("notice", "html", ["apiDomain = api-eu.band.us"]) },
    );
    expect(alerts).toEqual([]);
    expect(notices[0]).toMatch(/informational/);
  });

  it("alerts on endpoint version changes", () => {
    const { alerts } = compareTracked(
      { "endpoint.update_schedule": dataItem("alert", "web", ["v2.0.4"]) },
      { "endpoint.update_schedule": dataItem("alert", "web", ["v2.0.5"]) },
    );
    expect(alerts[0].diff).toEqual(["- v2.0.4", "+ v2.0.5"]);
  });
});

describe("helpers", () => {
  it("distinguishes get_schedule from get_schedules", () => {
    const src = 'u:"https://api.band.us/v1.6.0/get_schedules",v:"/v1.5.0/get_schedule?x=1"';
    expect(findEndpointVersions(src, "get_schedule")).toEqual(["v1.5.0"]);
    expect(findEndpointVersions(src, "get_schedules")).toEqual(["v1.6.0"]);
  });

  it("redacts the getKey secret and volatile numbers", () => {
    const gk = parseGetKey(
      "var Loader={path: 'https://ssl.pstatic.net/cmstatic/auth/js/abc123/'};\n" +
        "Loader.add({src: ['BandWebAuthModule.js'], onload: function() { authCallBack_1792820472000(new BandWebAuthModule({\n" +
        "secretKey: 'TOPSECRET',\ntimeCorrection: 1792820472706 -new Date().getTime(),\nisJwtType : false\n})); }});",
    );
    expect(gk.moduleHash).toBe("abc123");
    expect(gk.files).toEqual(["BandWebAuthModule.js"]);
    expect(gk.callback).toBe("authCallBack_1792820472000");
    const text = gk.templateLines.join("\n");
    expect(text).not.toContain("TOPSECRET");
    expect(text).not.toContain("1792820472706");
    expect(text).toContain("isJwtType : false");
  });

  it("chooses the smallest chunks that cover all endpoints", () => {
    const hits = [
      { id: "8", size: 1_500_000, names: new Set(["a", "b", "c"]) },
      { id: "9", size: 100_000, names: new Set(["a"]) },
      { id: "10", size: 12_000, names: new Set(["b", "c"]) },
    ];
    expect(chooseChunkCover(hits, ["a", "b", "c"])).toEqual(["9", "10"]);
  });

  it("lineDiff keeps context and elides the rest", () => {
    const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];
    const b = [...a];
    b[8] = "X";
    expect(lineDiff(a, b, 1)).toEqual(["  …", "  8", "- 9", "+ X"]);
  });
});
