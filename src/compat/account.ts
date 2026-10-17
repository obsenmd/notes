import { ipcRenderer } from "../../platforms/platform";
import { t } from "../i18n";
/**
 * Account authentication client used by the publishing surface.
 *
 * The service contract stores the account credential locally under
 * `obsidian-account`; it sends that opaque token in JSON request bodies and
 * does not use an Authorization header.
 */

export const ACCOUNT_SESSION_KEY = "obsidian-account";

export interface AccountSession {
  token: string;
  email: string;
  name: string;
  license: string;
  key?: string;
}

export interface AccountStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AccountFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AccountClientOptions {
  /** Account API origin, for example `https://api.obsidian.md`. */
  origin: string;
  storage: AccountStorage;
  fetch?: AccountFetch;
}

export interface SignInCredentials {
  email: string;
  password: string;
  /** Empty/omitted until the server requests multi-factor authentication. */
  mfa?: string;
}

export class AccountRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AccountRequestError";
  }
}

/** Small account API with a persisted local session. */
export class AccountClient {
  private readonly origin: string;
  private readonly fetcher: AccountFetch;
  private readonly sessionKey: string;

  constructor(private readonly options: AccountClientOptions) {
    this.origin = options.origin.replace(/\/+$/, "");
    this.sessionKey = this.origin === "https://api.obsidian.md" ? ACCOUNT_SESSION_KEY : `${ACCOUNT_SESSION_KEY}:${this.origin}`;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get session(): AccountSession | null {
    const serialized = this.options.storage.getItem(this.sessionKey);
    if (!serialized) return null;
    try {
      const value: unknown = JSON.parse(serialized);
      if (!isRecord(value) || typeof value.token !== "string" || !value.token) return null;
      return normalizeSession(value, value.token);
    } catch {
      return null;
    }
  }

  get isSignedIn(): boolean {
    return this.session !== null;
  }

  async signIn(credentials: SignInCredentials): Promise<AccountSession> {
    const mfa = credentials.mfa ?? "";
    if (mfa && !/^\d{6}$/.test(mfa)) throw new AccountRequestError(t("obsen.account.error-mfa-code"));
    const response = await this.request("/user/signin", {
      email: credentials.email,
      password: credentials.password,
      mfa,
    });
    return this.persist(response, response.token);
  }

  /** Revalidate the saved token and adopt a replacement token when returned. */
  async refresh(): Promise<AccountSession> {
    const current = this.requireSession();
    const response = await this.request("/user/authtoken", { token: current.token });
    return this.persist(response, response.token || current.token);
  }

  /** Fetch current profile and license data without rotating the credential. */
  async info(): Promise<AccountSession> {
    const current = this.requireSession();
    const response = await this.request("/user/info", { token: current.token });
    return this.persist(response, current.token);
  }

  /** Always remove local credentials, including when the remote session expired. */
  async signOut(): Promise<void> {
    const current = this.session;
    try {
      if (current) await this.request("/user/signout", { token: current.token });
    } catch (error) {
      if (!(error instanceof AccountRequestError) || !["Not logged in", t("obsen.account.error-not-logged-in")].some(text => error.message.includes(text))) throw error;
    } finally {
      this.options.storage.removeItem(this.sessionKey);
    }
  }

  private requireSession(): AccountSession {
    const current = this.session;
    if (!current) throw new AccountRequestError(t("obsen.account.error-not-logged-in"));
    return current;
  }

  private async request(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.options.fetch && typeof window !== "undefined") {
      const payload = await ipcRenderer.invoke("obsen-account-request", this.origin, path, body);
      if (!isRecord(payload)) throw new AccountRequestError(t("obsen.account.error-invalid-response"));
      if (payload.error) throw new AccountRequestError(payload.error === "Not logged in" ? t("obsen.account.error-not-logged-in") : String(payload.error));
      return payload;
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Do not attach request data to errors: it may contain passwords or tokens.
      throw new AccountRequestError(t("obsen.account.error-unreachable-server"));
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AccountRequestError(t("obsen.account.error-invalid-response"), response.status);
    }
    if (!isRecord(payload)) {
      throw new AccountRequestError(t("obsen.account.error-invalid-response"), response.status);
    }
    if (typeof payload.error === "string" && payload.error) {
      throw new AccountRequestError(payload.error === "Not logged in" ? t("obsen.account.error-not-logged-in") : payload.error, response.status);
    }
    if (!response.ok) {
      throw new AccountRequestError(t("obsen.account.error-request", { status: response.status }), response.status);
    }
    return payload;
  }

  private persist(payload: Record<string, unknown>, fallbackToken?: unknown): AccountSession {
    const token = typeof payload.token === "string" && payload.token ? payload.token
      : typeof fallbackToken === "string" && fallbackToken ? fallbackToken : "";
    if (!token) throw new AccountRequestError(t("obsen.account.error-session"));
    const session = normalizeSession(payload, token);
    this.options.storage.setItem(this.sessionKey, JSON.stringify(session));
    return session;
  }
}

function normalizeSession(value: Record<string, unknown>, token: string): AccountSession {
  return {
    token,
    email: typeof value.email === "string" ? value.email : "",
    name: typeof value.name === "string" ? value.name : "",
    license: typeof value.license === "string" ? value.license : "",
    ...(typeof value.key === "string" ? { key: value.key } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
