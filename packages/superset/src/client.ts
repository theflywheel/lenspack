// Superset's REST API (/api/v1) over plain fetch. Signs in as one service
// account with the database provider, keeps the session cookie the CSRF token
// is bound to, and signs in again when the access token expires.

export type SupersetOptions = {
  url: string;
  username: string;
  password: string;
  /** "db" (the default) or "ldap". OAuth-only deployments need a db service account. */
  provider?: "db" | "ldap";
  timeoutMs?: number;
  fetch?: typeof fetch;
};

export class SupersetError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "SupersetError";
  }
}

export type SupersetClient = {
  readonly url: string;
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body: unknown): Promise<T>;
  put<T = any>(path: string, body: unknown): Promise<T>;
  delete<T = any>(path: string): Promise<T>;
};

/** Superset's list endpoints take a rison `q`; this covers the shapes used here (objects, arrays, strings, numbers, booleans). */
export function rison(v: unknown): string {
  if (v === null || v === undefined) return "!n";
  if (v === true) return "!t";
  if (v === false) return "!f";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return /^[A-Za-z_][A-Za-z0-9_.\-/~]*$/.test(v) ? v : `'${v.replace(/!/g, "!!").replace(/'/g, "!'")}'`;
  if (Array.isArray(v)) return `!(${v.map(rison).join(",")})`;
  return `(${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${k}:${rison(x)}`)
    .join(",")})`;
}

export function supersetClient(opts: SupersetOptions): SupersetClient {
  const base = opts.url.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  let token: string | null = null;
  let csrf: string | null = null;
  const cookies = new Map<string, string>();
  let signingIn: Promise<void> | null = null;

  const keepCookies = (res: Response) => {
    const set = (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const c of set) {
      const [pair] = c.split(";");
      const i = pair!.indexOf("=");
      if (i > 0) cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  };
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

  async function raw(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", referer: base };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth && token) headers.authorization = `Bearer ${token}`;
    if (auth && csrf && method !== "GET") headers["x-csrftoken"] = csrf;
    if (cookies.size) headers.cookie = cookieHeader();
    const res = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    keepCookies(res);
    return res;
  }

  async function signIn() {
    cookies.clear();
    const res = await raw("POST", "/api/v1/security/login", { username: opts.username, password: opts.password, provider: opts.provider ?? "db", refresh: false }, false);
    if (!res.ok) throw new SupersetError(res.status, `Superset sign-in failed (${res.status}): check the service account`, await res.text().catch(() => ""));
    token = ((await res.json()) as { access_token: string }).access_token;
    const c = await raw("GET", "/api/v1/security/csrf_token/");
    if (!c.ok) throw new SupersetError(c.status, `Superset CSRF token failed (${c.status})`);
    csrf = ((await c.json()) as { result: string }).result;
  }

  async function call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    if (!token) await (signingIn ??= signIn().finally(() => (signingIn = null)));
    const res = await raw(method, path, body);
    // An expired token or a lost CSRF session: sign in once more and retry.
    if ((res.status === 401 || (res.status === 400 && method !== "GET")) && !retried) {
      const text = await res.clone().text();
      if (res.status === 401 || /csrf/i.test(text)) {
        token = null;
        return call(method, path, body, true);
      }
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg = typeof parsed === "object" && parsed ? ((parsed as any).message ?? (parsed as any).errors?.[0]?.message ?? text) : text;
      throw new SupersetError(res.status, `Superset ${method} ${path.split("?")[0]} → ${res.status}: ${(typeof msg === "string" ? msg : JSON.stringify(msg)).slice(0, 300)}`, parsed);
    }
    return parsed as T;
  }

  return {
    url: base,
    get: (path) => call("GET", path),
    post: (path, body) => call("POST", path, body),
    put: (path, body) => call("PUT", path, body),
    delete: (path) => call("DELETE", path),
  };
}
