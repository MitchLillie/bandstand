import { randomBytes, timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { CookieJar } from "../cookies";

/**
 * Default port for the loopback login receiver. Both the Band Tools extension and
 * the bookmarklet POST the browser's BAND session here so `bandstand login`
 * doesn't have to walk you through DevTools.
 */
export const DEFAULT_LOGIN_PORT = 7238;

/** Max bytes we'll read from a `POST /session` body before bailing. */
const MAX_BODY_BYTES = 64 * 1024;

export interface LoopbackLoginResult {
  /** The cookie jar to persist — always has `band_session` + `secretKey`. */
  jar: CookieJar;
  /**
   * `true` when the sender presented the matching one-time nonce (the extension
   * auto-pair path). `false` for the bookmarklet, which can't read the nonce —
   * the CLI should show a fingerprint and confirm before saving.
   */
  trusted: boolean;
  /** How the session arrived, for logging. */
  via: "extension" | "bookmarklet" | "unknown";
}

export interface LoopbackLoginOptions {
  /**
   * Port to listen on. Defaults to {@link DEFAULT_LOGIN_PORT}. Pass `0` for an
   * OS-assigned ephemeral port (tests); the real port is reported via
   * {@link LoopbackLoginOptions.onListening}.
   */
  port?: number;
  /** Bind address. Defaults to `127.0.0.1` — never expose this to the network. */
  host?: string;
  /** Give up and reject after this long. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Called once the server is listening, with the landing-page URL and nonce. */
  onListening?: (info: { url: string; port: number; nonce: string }) => void;
  /** Abort (e.g. on SIGINT) to reject early and fall back to manual paste. */
  signal?: AbortSignal;
}

/** Raised when the receiver gives up without a session (timeout or abort). */
export class LoginTimeoutError extends Error {
  constructor(message = "no session received") {
    super(message);
    this.name = "LoginTimeoutError";
  }
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  return {
    "access-control-allow-origin": typeof origin === "string" && origin ? origin : "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * DNS-rebinding guard. The landing page embeds the one-time nonce, so a hostile
 * site that rebinds its own hostname to 127.0.0.1 must not be able to read it
 * (same-origin from its point of view). Browsers always send the original
 * hostname in `Host`, so only accept loopback names on our port.
 */
function hostAllowed(hostHeader: string | undefined, bindHost: string, port: number): boolean {
  if (!hostHeader) return false;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
    `${bindHost}:${port}`,
  ]);
  return allowed.has(hostHeader.toLowerCase());
}

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The static, nonce-free bookmarklet source. Drag to the bookmarks bar once. */
export function bookmarkletSource(port: number = DEFAULT_LOGIN_PORT): string {
  // Runs on band.us: reads band_session from document.cookie, pulls the HttpOnly
  // secretKey out of the auth.band.us/s/login/getKey JSONP (same-site, so the
  // cookie rides along), then POSTs both to the loopback receiver.
  const js = `(function(){
var P=${port};
if(!/(^|\\.)band\\.us$/.test(location.hostname)){alert("Open band.us and sign in first, then click this.");return;}
var m=document.cookie.match(/(?:^|;\\s*)band_session=([^;]+)/);
var bs=m&&decodeURIComponent(m[1]);
var ts=Date.now(),cb="authCallBack_"+ts;
window[cb]=function(d){
try{
var sk=((d&&d.secretKey)||"").replace(/^"+|"+$/g,"");
if(!bs||!sk){alert("Not signed in? band_session:"+(!!bs)+" secretKey:"+(!!sk));return;}
fetch("http://127.0.0.1:"+P+"/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({band_session:bs,secretKey:sk,via:"bookmarklet"})})
.then(function(r){alert(r.ok?"Sent to bandstand \\u2713  Check your terminal.":"bandstand replied "+r.status+". Run: bandstand login");})
.catch(function(){alert("Couldn't reach bandstand on port "+P+".\\nRun \`bandstand login\` first, then click again.");});
}finally{delete window[cb];}
};
var s=document.createElement("script");
s.src="https://auth.band.us/s/login/getKey?callback="+cb+"&_="+ts;
s.onerror=function(){alert("getKey request failed \\u2014 are you signed in to band.us?");};
document.body.appendChild(s);
})();`;
  return `javascript:${encodeURIComponent(js.replace(/\n/g, ""))}`;
}

function landingPage(port: number): string {
  const bookmarklet = bookmarkletSource(port);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bandstand login</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.3rem; margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 1.25rem 0 .5rem; }
  .muted { opacity: .7; }
  #status { margin: 1.25rem 0; padding: .75rem 1rem; border-radius: .5rem; background: rgba(127,127,127,.12); }
  #status.ok { background: rgba(45,160,90,.18); }
  .bm { display: inline-block; margin: .5rem 0; padding: .35rem .8rem; border: 1px solid currentColor; border-radius: .4rem; text-decoration: none; font-weight: 600; }
  hr { border: none; border-top: 1px solid rgba(127,127,127,.25); margin: 1.75rem 0; }
  code { background: rgba(127,127,127,.15); padding: .1em .35em; border-radius: .25em; }
</style>
</head>
<body>
<h1>bandstand login</h1>
<p class="muted">Your terminal is waiting for a BAND session from this browser.</p>

<div id="status">Waiting for your session…</div>

<h2>With the Band Tools extension</h2>
<p>With this tab open, click the <strong>Band Tools</strong> icon in your toolbar,
then <strong>Send BAND session to bandstand</strong>. No prompt in the terminal.</p>
<p class="muted">No button in the popup? Band Tools isn't installed or is out of date,
so use the bookmarklet below.</p>

<hr>

<h2>No extension? Use the bookmarklet</h2>
<p>Drag this to your bookmarks bar, then open
<a href="https://www.band.us/" target="_blank" rel="noreferrer">band.us</a> (signed
in) and click it:</p>
<p><a class="bm" href="${bookmarklet}">bandstand login</a></p>
<p class="muted">It reads your <code>band_session</code> and <code>secretKey</code>
and posts them to <code>127.0.0.1:${port}</code> — nowhere else. The terminal
will show a fingerprint to confirm.</p>

<script>
  // The listener shuts down right after it accepts a session, so a poll will
  // often just find it gone; say so rather than spinning forever.
  var el = document.getElementById("status");
  var poll = setInterval(function () {
    fetch("/status").then(function (r) { return r.json(); }).then(function (s) {
      if (s && s.received) {
        clearInterval(poll);
        el.textContent = "✓ Session received — you can close this tab.";
        el.className = "ok";
      }
    }).catch(function () {
      clearInterval(poll);
      el.textContent = "bandstand has stopped listening — check your terminal for the result.";
    });
  }, 1000);
</script>
</body>
</html>`;
}

/**
 * Start a loopback HTTP server and resolve once the browser (extension or
 * bookmarklet) posts a BAND session to it. Rejects with {@link LoginTimeoutError}
 * on timeout or abort. The server is always closed before this settles.
 */
export function receiveSessionViaLoopback(
  options: LoopbackLoginOptions = {},
): Promise<LoopbackLoginResult> {
  const host = options.host ?? "127.0.0.1";
  const wantPort = options.port ?? DEFAULT_LOGIN_PORT;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const nonce = randomBytes(16).toString("hex");

  return new Promise<LoopbackLoginResult>((resolve, reject) => {
    let received = false;
    let settled = false;
    let boundPort = wantPort;

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const cors = corsHeaders(req);

      if (!hostAllowed(req.headers.host, host, boundPort)) {
        send(res, 421, "misdirected request", { "content-type": "text/plain" });
        return;
      }

      if (req.method === "OPTIONS") {
        send(res, 204, "", cors);
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        send(res, 200, landingPage(boundPort), {
          "content-type": "text/html; charset=utf-8",
          // The nonce lives only in the URL fragment the CLI opens (which Band Tools'
          // popup reads off the tab), never in this page. Still: no caching, no framing.
          "cache-control": "no-store",
          "content-security-policy": "frame-ancestors 'none'",
          "x-frame-options": "DENY",
          "referrer-policy": "no-referrer",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/status") {
        send(res, 200, JSON.stringify({ received }), {
          ...cors,
          "content-type": "application/json",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/session") {
        readBody(req)
          .then((raw) => {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              send(res, 400, JSON.stringify({ ok: false, error: "invalid JSON" }), {
                ...cors,
                "content-type": "application/json",
              });
              return;
            }

            const bandSession = typeof parsed.band_session === "string" ? parsed.band_session : "";
            const secretKey = typeof parsed.secretKey === "string" ? parsed.secretKey : "";
            if (!bandSession || !secretKey) {
              send(
                res,
                400,
                JSON.stringify({ ok: false, error: "band_session and secretKey required" }),
                { ...cors, "content-type": "application/json" },
              );
              return;
            }

            const jar: CookieJar = { band_session: bandSession, secretKey };
            const extra = parsed.cookies;
            if (extra && typeof extra === "object") {
              for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
                if (typeof v === "string" && !(k in jar)) jar[k] = v;
              }
            }

            const trusted = typeof parsed.nonce === "string" && safeEqual(parsed.nonce, nonce);
            const viaRaw = parsed.via;
            const via: LoopbackLoginResult["via"] =
              viaRaw === "extension" || viaRaw === "bookmarklet" ? viaRaw : "unknown";

            received = true;
            send(res, 200, JSON.stringify({ ok: true }), {
              ...cors,
              "content-type": "application/json",
            });
            finish(null, { jar, trusted, via });
          })
          .catch(() => {
            send(res, 400, JSON.stringify({ ok: false, error: "bad request" }), {
              ...cors,
              "content-type": "application/json",
            });
          });
        return;
      }

      send(res, 404, "not found", cors);
    });

    const timer = setTimeout(() => finish(new LoginTimeoutError()), timeoutMs);
    timer.unref?.();

    const onAbort = () => finish(new LoginTimeoutError("aborted"));
    if (options.signal) {
      if (options.signal.aborted) {
        finish(new LoginTimeoutError("aborted"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    function finish(err: Error | null, value?: LoopbackLoginResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      // Give the HTTP response a tick to flush before tearing the socket down.
      setTimeout(() => {
        server.close(() => {
          if (err) reject(err);
          else resolve(value as LoopbackLoginResult);
        });
        // close() waits for keep-alive sockets; don't hang on them.
        server.closeAllConnections?.();
      }, 10);
    }

    server.on("error", (err) => finish(err));
    server.listen(wantPort, host, () => {
      boundPort = (server.address() as AddressInfo).port;
      options.onListening?.({
        url: `http://${host}:${boundPort}/#pair=${nonce}`,
        port: boundPort,
        nonce,
      });
    });
  });
}
