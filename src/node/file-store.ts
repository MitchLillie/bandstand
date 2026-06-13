import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CookieJar } from "../cookies";
import type { CookieStore } from "../store";

/** Default cookie-jar path, overridable with `BAND_STATE`. */
export const DEFAULT_STATE_PATH = process.env.BAND_STATE ?? join(homedir(), ".band_session.json");

interface StateFile {
  cookies?: CookieJar;
  /** Legacy single-token shape we still migrate from. */
  band_session?: string;
}

/** Cookie jar persisted to a `0600` JSON file (default `~/.band_session.json`). */
export class FileCookieStore implements CookieStore {
  constructor(private readonly path: string = DEFAULT_STATE_PATH) {}

  async load(): Promise<CookieJar> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw err;
    }
    const parsed = JSON.parse(raw) as StateFile;
    if (parsed.cookies) return parsed.cookies;
    if (typeof parsed.band_session === "string") return { band_session: parsed.band_session };
    return {};
  }

  async save(jar: CookieJar): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({ cookies: jar }), "utf8");
    await chmod(this.path, 0o600).catch(() => {});
  }
}
