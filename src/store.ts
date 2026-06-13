import type { CookieJar } from "./cookies";

/**
 * Pluggable persistence for the cookie jar. The core client is runtime-agnostic;
 * Node consumers get {@link FileCookieStore}, tests/browsers can use
 * {@link MemoryCookieStore} or their own implementation.
 */
export interface CookieStore {
  load(): Promise<CookieJar>;
  save(jar: CookieJar): Promise<void>;
}

/** In-memory store — handy for tests, ephemeral sessions, and non-Node runtimes. */
export class MemoryCookieStore implements CookieStore {
  private jar: CookieJar;

  constructor(jar: CookieJar = {}) {
    this.jar = { ...jar };
  }

  async load(): Promise<CookieJar> {
    return { ...this.jar };
  }

  async save(jar: CookieJar): Promise<void> {
    this.jar = { ...jar };
  }
}
