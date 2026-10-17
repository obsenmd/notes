/** Minimal, UI-independent client for the Obsidian Publish management protocol. */

export interface PublishClientOptions {
  accountOrigin: string;
  registryOrigin: string;
  /** Defaults to globalThis.fetch, and is injectable for desktop bridges or offline use. */
  fetch?: typeof fetch;
}

export interface PublishSite {
  id: string;
  host: string;
  [key: string]: unknown;
}

export interface PublishSiteList {
  sites: PublishSite[];
  shared: (PublishSite & { share_uid?: string })[];
  limit: number;
}

export interface PublishFileEntry {
  path: string;
  hash: string;
  ctime?: number;
  mtime?: number;
  size?: number;
  [key: string]: unknown;
}

export interface PublishFileList {
  owner: boolean;
  files: PublishFileEntry[];
}

/** Settings accepted by the site's authenticated `/api/options` endpoint. */
export type PublishSiteOptions = Record<string, unknown>;

export class PublishRequestError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "PublishRequestError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Implements the minimal account, slug registry and per-site file operations.
 * Account failures use `{error}`, while Publish endpoints use `{code,message}`.
 */
export class PublishClient {
  private readonly requestFetch: typeof fetch;

  constructor(private readonly options: PublishClientOptions) {
    this.requestFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async list(token: string): Promise<PublishSiteList> {
    const result = await this.accountJson<Partial<PublishSiteList>>("/publish/list", { token });
    return {
      sites: Array.isArray(result.sites) ? result.sites : [],
      shared: Array.isArray(result.shared) ? result.shared : [],
      limit: typeof result.limit === "number" ? result.limit : 0,
    };
  }

  create(token: string): Promise<PublishSite> {
    return this.accountJson("/publish/create", { token });
  }

  /** Check availability; an unused slug is reported as a semantic NOTFOUND error. */
  async slug(token: string, slug: string): Promise<void> {
    try {
      await this.registryJson("/api/site", { token, slug });
    } catch (error) {
      if (error instanceof PublishRequestError && error.code === "NOTFOUND") return;
      throw error;
    }
    throw new PublishRequestError("SLUGINUSE", `Slug is already in use: ${slug}`);
  }

  async setSlug(token: string, site: PublishSite, slug: string): Promise<void> {
    await this.registryJson("/api/slug", { token, id: site.id, host: site.host, slug });
  }

  async slugs(token: string, ids: string[]): Promise<Record<string, string>> {
    return this.registryJson("/api/slugs", { token, ids });
  }

  async listFiles(token: string, site: PublishSite): Promise<PublishFileList> {
    const origin = this.backendOrigin(site.host);
    const result = await this.siteJson<{ owner?: unknown; files?: unknown }>(origin, "/api/list", {
      id: site.id, token, version: 2,
    });
    return {
      owner: result.owner === true,
      files: Array.isArray(result.files) ? result.files as PublishFileEntry[] : [],
    };
  }

  async upload(token: string, site: PublishSite, path: string, bytes: ArrayBuffer | Uint8Array,
    hash: string, timestamps: { ctime?: number; mtime?: number } = {}): Promise<void> {
    const body = bytes instanceof Uint8Array
      ? bytes.slice().buffer as ArrayBuffer
      : bytes;
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "obs-token": token,
      "obs-id": site.id,
      "obs-path": encodeURIComponent(path),
      "obs-hash": hash,
    });
    // File stats can carry fractional milliseconds in the desktop adapter, while
    // the service stores these as signed integer Unix milliseconds.
    if (Number.isFinite(timestamps.ctime) && timestamps.ctime! >= 0) headers.set("obs-ctime", String(Math.trunc(timestamps.ctime!)));
    if (Number.isFinite(timestamps.mtime) && timestamps.mtime! >= 0) headers.set("obs-mtime", String(Math.trunc(timestamps.mtime!)));
    await this.jsonRequest(this.backendOrigin(site.host), "/api/upload", {
      method: "POST", headers, body, credentials: "include",
    }, true);
  }

  async remove(token: string, site: PublishSite, path: string): Promise<void> {
    await this.siteJson(this.backendOrigin(site.host), "/api/remove", {
      id: site.id, token, path,
    });
  }

  /** Read site options. The endpoint returns the options object directly. */
  getOptions(token: string, site: PublishSite): Promise<PublishSiteOptions> {
    return this.siteJson<PublishSiteOptions>(this.backendOrigin(site.host), "/api/options", {
      id: site.id, token,
    });
  }

  /** Send only changed settings; compatible servers merge this object by key. */
  updateOptions(token: string, site: PublishSite, options: PublishSiteOptions): Promise<void> {
    return this.siteJson(this.backendOrigin(site.host), "/api/options", {
      id: site.id, token, options,
    });
  }

  private accountJson<T>(path: string, body: unknown): Promise<T> {
    return this.jsonRequest<T>(this.options.accountOrigin, path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, false);
  }

  private registryJson<T>(path: string, body: unknown): Promise<T> {
    return this.jsonRequest<T>(this.options.registryOrigin, path, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      credentials: "include",
    }, true);
  }

  private siteJson<T>(origin: string, path: string, body: unknown): Promise<T> {
    return this.jsonRequest<T>(origin, path, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
      credentials: "include",
    }, true);
  }

  private async jsonRequest<T>(origin: string, path: string, init: RequestInit,
    publishEnvelope: boolean): Promise<T> {
    let response: Response;
    try {
      response = await this.requestFetch(this.join(origin, path), init);
    } catch (error) {
      throw new PublishRequestError("NET", error instanceof Error ? error.message : String(error));
    }
    if (response.status < 200 || response.status >= 400) {
      throw new PublishRequestError("NET", `Request failed (${response.status})`, response.status);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new PublishRequestError("NET", "Server returned invalid JSON", response.status);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new PublishRequestError("NET", "Server returned an invalid response", response.status);
    }
    const envelope = value as Record<string, unknown>;
    if (publishEnvelope && envelope.code && envelope.message) {
      throw new PublishRequestError(String(envelope.code), String(envelope.message), response.status);
    }
    if (!publishEnvelope && envelope.error) {
      throw new PublishRequestError("ACCOUNT", String(envelope.error), response.status);
    }
    return value as T;
  }

  private backendOrigin(host: string): string {
    if (/^https?:\/\//i.test(host)) return host.replace(/\/$/, "");
    return `${/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host) ? "http" : "https"}://${host}`;
  }

  private join(origin: string, path: string): string {
    return `${origin.replace(/\/$/, "")}${path}`;
  }
}
