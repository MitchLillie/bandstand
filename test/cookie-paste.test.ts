import { describe, expect, it } from "vitest";
import {
  EXPECTED_COOKIES,
  formatCookieReport,
  inspectCookies,
  parseCookieBlob,
} from "../src/cookie-paste";
import { extractSecret, serializeCookieHeader } from "../src/cookies";

// Values below are structurally real but server-invalid — safe to keep in the repo.
const SESSION = "BAND_SESSION_FIXTURE_OyNQoF80LcaxFd1EDdEeXJrosSSArcliOyNQoFsELcaxFdL";
const SECRET = '"SECRETKEY_FIXTURE_hSNQ7cYdmj+R+ZxtZU+3iaXBR+"';

/** Chrome DevTools → Application → Cookies, "select all rows + copy": tab-separated,
 *  no header row, empty cells for the flags a cookie doesn't set. */
const DEVTOOLS_ROWS = [
  ["ai", '"AI_FIXTURE_95727h1,"', ".band.us", "/", "Session", "23", "", "", "", "", "", "Medium"],
  [
    "as",
    '"AS_FIXTURE_99U9m74t:OCbVtZ61G9gPkrZsG3IuL4ZFrURm74tR6"',
    ".band.us",
    "/",
    "Session",
    "57",
    "",
    "✓",
    "",
    "",
    "",
    "Medium",
  ],
  ["band_session", SESSION, ".band.us", "/", "Session", "124", "", "", "", "", "", "Medium"],
  [
    "BBC",
    "BBC_FIXTURE_O2T21n3t-7574-1474-7w44-",
    ".band.us",
    "/",
    "2027-08-14T17:24:00.014Z",
    "39",
    "",
    "",
    "",
    "",
    "",
    "Medium",
  ],
  [
    "di",
    "DI_FIXTURE_FAx-Selrau_4-5XFq9FhKtTSii8wNanxFAxC0elrauASbhXFqX-hKtTSiigwNanx",
    ".band.us",
    "/",
    "2027-08-14T17:24:14.812Z",
    "76",
    "",
    "",
    "",
    "",
    "",
    "Medium",
  ],
  [
    "JSESSIONID",
    "JSESSIONID_FIXTURE_24RiE15LE3667",
    "www.band.us",
    "/",
    "Session",
    "42",
    "✓",
    "",
    "",
    "",
    "",
    "Medium",
  ],
  ["language", "en", ".band.us", "/", "2027-09-06T18:13:04.415Z", "10", "", "", "", "", "", "M"],
  ["last_used_method", "email", ".band.us", "/", "Session", "21", "", "✓", "", "", "", "Medium"],
  [
    "rt",
    '"RT_FIXTURE_hIvLKjfsYkbgFy1AbVYIRlnYBYuHV0KBh6vLK7fs4kb0Fyn2bVYIRlnYBYuHVEK"',
    ".auth.band.us",
    "/",
    "Session",
    "118",
    "",
    "✓",
    "",
    "",
    "",
    "Medium",
  ],
  ["secretKey", SECRET, ".band.us", "/s/login/getKey", "Session", "55", "✓", "✓", "", "", "", "M"],
  [
    "SESSION",
    "SESSION_FIXTURE_IMGxkdhC1H2EdhvEvfb5ha/eSiYUKlTI0MGxkd1CJHQ21h3E",
    "auth.band.us",
    "/",
    "Session",
    "71",
    "✓",
    "✓",
    "",
    "",
    "",
    "Medium",
  ],
];

const DEVTOOLS_HEADER = [
  "Name",
  "Value",
  "Domain",
  "Path",
  "Expires / Max-Age",
  "Size",
  "HttpOnly",
  "Secure",
  "SameSite",
  "Partition Key Site",
  "Cross Site",
  "Priority",
];

const table = (rows: string[][]) => rows.map((row) => row.join("\t")).join("\n");

/** The nine cookies a healthy session carries, as parsed from the table above. */
function expectFullSession(jar: Record<string, string>): void {
  expect(inspectCookies(jar).missing).toEqual([]);
  expect(jar.band_session).toBe(SESSION);
  expect(jar.secretKey).toBe(SECRET);
  expect(jar.JSESSIONID).toBe("JSESSIONID_FIXTURE_24RiE15LE3667");
}

describe("parseCookieBlob — document.cookie / legacy single line", () => {
  it("parses the format login has always accepted", () => {
    expect(parseCookieBlob("band_session=abc; language=en")).toEqual({
      band_session: "abc",
      language: "en",
    });
  });

  it("treats a bare token as band_session", () => {
    expect(parseCookieBlob("just-a-token")).toEqual({ band_session: "just-a-token" });
  });

  it("strips shell quotes around the whole paste and keeps '=' inside values", () => {
    expect(parseCookieBlob('"band_session=ab=="')).toEqual({ band_session: "ab==" });
  });

  it("tolerates a trailing semicolon and sloppy spacing", () => {
    expect(parseCookieBlob("  band_session=abc ;  secretKey=k ;  ")).toEqual({
      band_session: "abc",
      secretKey: "k",
    });
  });
});

describe("parseCookieBlob — DevTools Application panel table", () => {
  it("parses a real-shaped paste with no header row", () => {
    const jar = parseCookieBlob(table(DEVTOOLS_ROWS));
    expectFullSession(jar);
    expect(Object.keys(jar)).toHaveLength(11); // 9 expected + language + last_used_method
  });

  it("parses the same table with its header row", () => {
    expectFullSession(parseCookieBlob(table([DEVTOOLS_HEADER, ...DEVTOOLS_ROWS])));
  });

  it("keys off the header rather than fixed positions when columns are reordered", () => {
    const header = ["Domain", "Value", "HttpOnly", "Name"];
    const rows = [
      [".band.us", SESSION, "", "band_session"],
      [".band.us", SECRET, "✓", "secretKey"],
    ];
    expect(parseCookieBlob(table([header, ...rows]))).toEqual({
      band_session: SESSION,
      secretKey: SECRET,
    });
  });

  it("keeps quoted values verbatim — the browser sends the quotes back", () => {
    const jar = parseCookieBlob(table(DEVTOOLS_ROWS));
    expect(jar.ai).toBe('"AI_FIXTURE_95727h1,"');
    expect(jar.rt?.startsWith('"')).toBe(true);
    expect(serializeCookieHeader(jar)).toContain('ai="AI_FIXTURE_95727h1,"');
    // …and the HMAC key still comes out unquoted.
    expect(extractSecret(jar)).toBe("SECRETKEY_FIXTURE_hSNQ7cYdmj+R+ZxtZU+3iaXBR+");
  });

  it("survives tabs collapsed into spaces by an editor or chat client", () => {
    const spaced = DEVTOOLS_ROWS.map((row) => row.filter(Boolean).join("    ")).join("\n");
    expectFullSession(parseCookieBlob(spaced));
  });

  it("ignores a truncated final row and CRLF line endings", () => {
    const blob = `${table(DEVTOOLS_ROWS).replace(/\n/g, "\r\n")}\r\nhalf-a-ro`;
    expectFullSession(parseCookieBlob(blob));
  });
});

describe("parseCookieBlob — line-oriented pastes", () => {
  it("parses one name=value per line, no semicolons", () => {
    expect(parseCookieBlob(`band_session=${SESSION}\nsecretKey=${SECRET}\nBBC=xyz\n`)).toEqual({
      band_session: SESSION,
      secretKey: SECRET,
      BBC: "xyz",
    });
  });

  it("parses name<TAB>value with no header", () => {
    expect(parseCookieBlob(`band_session\t${SESSION}\nsecretKey\t${SECRET}`)).toEqual({
      band_session: SESSION,
      secretKey: SECRET,
    });
  });

  it("skips blank lines and surrounding whitespace", () => {
    expect(parseCookieBlob("\n\n  band_session=abc\n\n  secretKey=k  \n\n")).toEqual({
      band_session: "abc",
      secretKey: "k",
    });
  });
});

describe("parseCookieBlob — JSON", () => {
  it("parses an array of cookie objects (extension export / CDP getAllCookies)", () => {
    const json = JSON.stringify([
      { name: "band_session", value: SESSION, domain: ".band.us", path: "/", httpOnly: true },
      { name: "secretKey", value: SECRET, domain: ".band.us", path: "/s/login/", secure: true },
      { name: "language", value: "en", domain: ".band.us", path: "/" },
    ]);
    expect(parseCookieBlob(json)).toEqual({
      band_session: SESSION,
      secretKey: SECRET,
      language: "en",
    });
  });

  it("parses a flat {name: value} object", () => {
    expect(parseCookieBlob('{"band_session":"abc","secretKey":"k","di":"web-1"}')).toEqual({
      band_session: "abc",
      secretKey: "k",
      di: "web-1",
    });
  });

  it("unwraps a {cookies: [...]} envelope and non-string scalars", () => {
    const json = JSON.stringify({
      cookies: [
        { Name: "band_session", Value: SESSION },
        { name: "secretKey", value: SECRET },
        { name: "di", value: 42 },
      ],
      origins: [],
    });
    expect(parseCookieBlob(json)).toEqual({
      band_session: SESSION,
      secretKey: SECRET,
      di: "42",
    });
  });

  it("does not throw — or invent a cookie — on truncated JSON", () => {
    expect(parseCookieBlob('[{"name":"band_session","value":"abc"},{"name":"secre')).toEqual({});
  });
});

describe("parseCookieBlob — Copy as cURL", () => {
  const curl = [
    "curl 'https://www.band.us/api/schedule' \\",
    "  -H 'accept: application/json, text/plain, */*' \\",
    `  -H 'cookie: band_session=${SESSION}; secretKey=${SECRET}; BBC=xyz' \\`,
    "  -H 'user-agent: Mozilla/5.0' \\",
    "  --compressed",
  ].join("\n");

  it("extracts the Cookie header from a whole curl command", () => {
    expect(parseCookieBlob(curl)).toEqual({
      band_session: SESSION,
      secretKey: SECRET,
      BBC: "xyz",
    });
  });

  it("handles the -b/--cookie flag and bash $'…' quoting", () => {
    expect(parseCookieBlob(`curl https://www.band.us/ -b 'band_session=abc; secretKey=k'`)).toEqual(
      {
        band_session: "abc",
        secretKey: "k",
      },
    );
    expect(parseCookieBlob(`curl https://www.band.us/ -H $"Cookie: band_session=abc"`)).toEqual({
      band_session: "abc",
    });
  });

  it("does not mistake a cookie-jar filename for cookies", () => {
    expect(parseCookieBlob("curl https://www.band.us/ -b cookies.txt")).toEqual({});
  });
});

describe("parseCookieBlob — junk tolerance", () => {
  it("returns an empty jar for empty or whitespace-only input", () => {
    expect(parseCookieBlob("")).toEqual({});
    expect(parseCookieBlob("   \n\t \n")).toEqual({});
  });

  it("returns an empty jar for a header row with no data", () => {
    expect(parseCookieBlob(DEVTOOLS_HEADER.join("\t"))).toEqual({});
  });

  it("skips lines that cannot be a cookie name", () => {
    const jar = parseCookieBlob(
      ["Request Cookies", "band_session=abc", "-- 12 cookies --", "secretKey=k"].join("\n"),
    );
    expect(jar).toEqual({ band_session: "abc", secretKey: "k" });
  });
});

describe("inspectCookies", () => {
  it("names what is present and what is missing", () => {
    const report = inspectCookies(parseCookieBlob(table(DEVTOOLS_ROWS)));
    expect(report.present).toEqual([...EXPECTED_COOKIES]);
    expect(report.missing).toEqual([]);
    expect(report.missingRequired).toEqual([]);
    expect(report.names).toContain("language");
  });

  it("flags a partial paste that is missing secretKey", () => {
    // The classic failure: `copy(document.cookie)` in the Console, which cannot see
    // the HttpOnly cookies at all.
    const jar = parseCookieBlob(`band_session=${SESSION}; language=en; BBC=xyz`);
    const report = inspectCookies(jar);
    expect(report.missingRequired).toEqual(["secretKey"]);
    expect(report.missing).toContain("secretKey");
    expect(report.missing).toContain("JSESSIONID");
    expect(report.present).toEqual(["band_session", "BBC"]);
  });

  it("treats an empty value as absent", () => {
    expect(inspectCookies({ band_session: "abc", secretKey: "  " }).missingRequired).toEqual([
      "secretKey",
    ]);
  });
});

describe("formatCookieReport", () => {
  it("reports counts and names", () => {
    const report = formatCookieReport(parseCookieBlob(table(DEVTOOLS_ROWS)));
    expect(report).toContain("recognized 11 cookies");
    expect(report).toContain("9/9 expected present");
    expect(report).not.toContain("missing:");
  });

  it("names the missing cookies explicitly", () => {
    const report = formatCookieReport({ band_session: "abc" });
    expect(report).toContain("recognized 1 cookie;");
    expect(report).toContain("missing: secretKey, ai, as, rt, SESSION, JSESSIONID, BBC, di");
  });

  it("never prints a cookie value", () => {
    const jar = parseCookieBlob(table(DEVTOOLS_ROWS));
    const report = formatCookieReport(jar);
    for (const value of Object.values(jar)) {
      if (value.length < 4) continue; // "en" is a substring of half the alphabet
      expect(report).not.toContain(value);
    }
  });
});

describe("tabs lost to copy-paste", () => {
  it("accepts a two-column pair separated by spaces", () => {
    const jar = parseCookieBlob("band_session   ABC123\nsecretKey   \"DEF456\"");
    expect(jar.band_session).toBe("ABC123");
    expect(jar.secretKey).toBe('"DEF456"');
  });

  it("accepts a single space as the separator", () => {
    expect(parseCookieBlob("band_session ABC123").band_session).toBe("ABC123");
  });

  it("does not read a two-word heading as a cookie", () => {
    // "Request Cookies" has exactly the shape of a space-separated pair.
    expect(parseCookieBlob("Request Cookies\nband_session ABC")).toEqual({
      band_session: "ABC",
    });
  });

  it("an unexpected cookie name still needs a real table row", () => {
    expect(parseCookieBlob("some_other_cookie ABC")).toEqual({});
    expect(parseCookieBlob("some_other_cookie\tABC\t.band.us")).toEqual({
      some_other_cookie: "ABC",
    });
  });

  it("still routes the one-line form to the name=value parser", () => {
    const jar = parseCookieBlob("band_session=ABC123; secretKey=DEF456");
    expect(jar.band_session).toBe("ABC123");
    expect(jar.secretKey).toBe("DEF456");
  });

  it("does not mistake a space-separated one-line paste for a table", () => {
    const jar = parseCookieBlob("band_session=ABC123; secretKey=DEF456; ai=X");
    expect(jar.ai).toBe("X");
    expect(Object.keys(jar)).toHaveLength(3);
  });
});
