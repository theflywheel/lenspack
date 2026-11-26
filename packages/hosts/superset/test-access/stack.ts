// The access suite's stack, one per Superset version: Postgres with the sample data, a stock apache/superset
// image with the plugin mounted and the fixtures made, and Lenspack itself (`lenspack superset`, from the source
// tree) behind Superset's own /lenspack route. Everything listens on 127.0.0.1 only: Superset runs in the host's
// network namespace so that it and Lenspack reach each other there. Linux with Docker; nothing paid is called.
//
// Two small servers run in the test process:
//   - a stub chat model, OpenAI-compatible, which calls the one tool a message names ("TOOL query {...}") and
//     then says "done", so the chat's tools run exactly as asked without a real model;
//   - a cut-off switch on the way from Lenspack to Superset (Lenspack's superset.url points at it), for the
//     outage case.
//
// Secrets (Superset's SECRET_KEY, the database and user passwords) are made fresh per run, handed to docker
// through its environment (never on a command line), kept in a 0700 temporary folder, and removed with the
// containers and their volumes when the stack stops.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer, request } from "node:http";
import { type AddressInfo, createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const plugin = fileURLToPath(new URL("../plugin/", import.meta.url));
const root = fileURLToPath(new URL("../../../../", import.meta.url));

/** Every container the suite makes carries this label: `docker rm -f -v $(docker ps -aq --filter label=lenspack-access-suite)` clears leftovers. */
export const LABEL = "lenspack-access-suite";
export const PACK = "access";

export type Fixtures = { datasets: { visits: number; stock: number }; dashboards: { a: number; b: number; c: number; t: number } };
export type Reply = { status: number; headers: IncomingMessage["headers"]; text: string; json: any };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = netServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** docker, with secrets passed by name from env (`-e NAME`), so they never show on a command line. */
function docker(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("docker", args, { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** One HTTP request, its path sent exactly as written (a URL would resolve ".." before sending). */
export function http(base: string, method: string, path: string, o: { headers?: Record<string, string>; body?: string | object } = {}): Promise<Reply> {
  const body = o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body);
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const r = request(
      { hostname, port, path, method, headers: { ...(body !== undefined && typeof o.body === "object" ? { "content-type": "application/json" } : {}), ...o.headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON: a stream or a page */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    r.on("error", reject);
    r.setTimeout(120_000, () => r.destroy(new Error(`${method} ${path}: no answer in 120 s`)));
    r.end(body);
  });
}

/** A browser signed in to Superset as one user: its session cookie, and requests through Superset (to /lenspack/... and Superset's own API). */
export class Session {
  private cookies = new Map<string, string>();
  /** root: the path Superset runs under ("" at the root, "/superset" with SUPERSET_APP_ROOT); every path sent starts with it. */
  constructor(
    readonly superset: string,
    readonly user: string,
    readonly root = "",
  ) {}

  private keep(res: Reply) {
    for (const c of [res.headers["set-cookie"] ?? []].flat()) {
      const [pair] = c.split(";");
      const at = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, at).trim(), pair!.slice(at + 1).trim());
    }
  }

  async send(method: string, path: string, o: { headers?: Record<string, string>; body?: string | object } = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await http(this.superset, method, `${this.root}${path}`, { ...o, headers: { ...(cookie ? { cookie } : {}), ...o.headers } });
    this.keep(res);
    return res;
  }

  /** Superset's own sign-in form, with its CSRF token. */
  async signIn(password: string) {
    const page = await this.send("GET", "/login/");
    const token = /name="csrf_token"[\s\S]*?value="([^"]+)"/.exec(page.text)?.[1];
    if (!token) throw new Error(`no sign-in form on Superset's /login/ (HTTP ${page.status})`);
    const form = new URLSearchParams({ csrf_token: token, username: this.user, password }).toString();
    const res = await this.send("POST", "/login/", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
    // Signed in: sent on to Superset's home. A failed sign-in is sent back to /login/.
    const to = String(res.headers.location ?? "");
    if (res.status !== 302 || to.includes("/login")) throw new Error(`${this.user} could not sign in to Superset (HTTP ${res.status} to ${to || "nowhere"})`);
    return this;
  }

  /** The session's cookies, for a browser signed in as the same user (openPage). */
  cookieList() {
    const { hostname } = new URL(this.superset);
    return [...this.cookies].map(([name, value]) => ({ name, value, domain: hostname, path: "/" }));
  }

  /** A request to Lenspack through Superset's /lenspack route. */
  lp(method: string, path: string, body?: object) {
    return this.send(method, `/lenspack/${path.replace(/^\//, "")}`, body === undefined ? {} : { body });
  }
}

/**
 * A headless browser signed in as the session's user, on a Superset page: the overlay and the chat run as they do for a
 * person. Playwright's Chromium (`pnpm exec playwright install --only-shell chromium`), or the one LENSPACK_CHROMIUM
 * names.
 */
export async function openPage(session: Session, path: string) {
  const { chromium } = await import("playwright");
  const executablePath = process.env.LENSPACK_CHROMIUM || undefined;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.addCookies(session.cookieList());
  const page = await context.newPage();
  await page.goto(`${session.superset}${path}`);
  return { page, close: () => browser.close() };
}

/** reuse: set when the reply came from a saved answer (which tier, and which saved entry). */
export type ChatResult = { status: number; error?: string; tools: { tool: string; input: any; output: any }[]; text: string; reuse?: { tier: string; entry: string } };

/** A chat turn through the UI message stream: the tools the stub model called, what each returned, and the reply's words. */
export function readChat(res: Reply): ChatResult {
  if (res.status !== 200) return { status: res.status, error: res.json?.error ?? res.text, tools: [], text: "" };
  const calls = new Map<string, { tool: string; input: any; output: any }>();
  let text = "";
  let error: string | undefined;
  let reuse: ChatResult["reuse"];
  for (const line of res.text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const e = JSON.parse(line.slice(6)) as { type: string; toolCallId?: string; toolName?: string; input?: unknown; output?: unknown; delta?: string; errorText?: string; data?: { tier: string; entry: string } };
    if (e.type === "tool-input-available") calls.set(e.toolCallId!, { tool: e.toolName!, input: e.input, output: undefined });
    else if (e.type === "tool-output-available") calls.get(e.toolCallId!)!.output = e.output;
    else if (e.type === "tool-output-error") calls.get(e.toolCallId!)!.output = { error: e.errorText };
    else if (e.type === "text-delta") text += e.delta;
    else if (e.type === "error") error = e.errorText;
    else if (e.type === "data-reuse" && e.data) reuse = { tier: e.data.tier, entry: e.data.entry };
  }
  return { status: 200, ...(error ? { error } : {}), tools: [...calls.values()], text, ...(reuse ? { reuse } : {}) };
}

/**
 * The stub model: an OpenAI-compatible /v1/chat/completions. A user message "TOOL <name> <json>" becomes one call
 * of that tool; once its result is back (or for any other message, the start-up probe included) it answers "done".
 */
function stubModel(): { server: Server; calls: () => number } {
  const reply = (res: ServerResponse, stream: boolean, message: { content?: string; tool_calls?: unknown[] }) => {
    const finish = message.tool_calls ? "tool_calls" : "stop";
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "stub", object: "chat.completion", created: 0, model: "stub", choices: [{ index: 0, message: { role: "assistant", content: message.content ?? null, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) }, finish_reason: finish }], usage }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null, extra = {}) => res.write(`data: ${JSON.stringify({ id: "stub", object: "chat.completion.chunk", created: 0, model: "stub", choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
    if (message.tool_calls) chunk({ role: "assistant", tool_calls: (message.tool_calls as object[]).map((c, index) => ({ index, ...c })) }, null);
    else chunk({ role: "assistant", content: message.content }, null);
    chunk({}, finish, { usage });
    res.end("data: [DONE]\n\n");
  };
  let calls = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls++;
      const body = JSON.parse(raw || "{}") as { stream?: boolean; messages?: { role: string; content: unknown }[] };
      const last = body.messages?.at(-1);
      const words = typeof last?.content === "string" ? last.content : Array.isArray(last?.content) ? (last!.content as { text?: string }[]).map((p) => p.text ?? "").join("") : "";
      const m = last?.role === "user" ? /^TOOL (\w+)\s*([\s\S]*)$/.exec(words.trim()) : null;
      if (m) return reply(res, !!body.stream, { tool_calls: [{ id: `call_${calls}`, type: "function", function: { name: m[1], arguments: m[2]?.trim() || "{}" } }] });
      reply(res, !!body.stream, { content: "done" });
    });
  });
  return { server, calls: () => calls };
}

/** Lenspack's way to Superset, with a switch that cuts it (every request's connection reset), for the outage case. */
function cutOff(target: string): { server: Server; cut: (on: boolean) => void } {
  let down = false;
  const { hostname, port } = new URL(target);
  const server = createServer((req, res) => {
    if (down) return req.socket.destroy();
    const up = request({ hostname, port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  return { server, cut: (on) => (down = on) };
}

const listen = (s: Server) => new Promise<number>((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));

export type Stack = {
  version: string;
  /** The path Superset runs under: "" at the root, else what SUPERSET_APP_ROOT says ("/superset"). */
  appRoot: string;
  superset: string;
  lenspack: string;
  fixtures: Fixtures;
  /** The key Superset signs identities with, derived from its SECRET_KEY as the plugin derives it. */
  identityKey: string;
  /** Lenspack's log so far. */
  log: () => string;
  /** How many calls the stub model has answered (the start-up probe included). */
  modelCalls: () => number;
  /** Cuts (true) or restores (false) Lenspack's way to Superset. */
  cut: (on: boolean) => void;
  /** Turns Superset's dashboard roles (DASHBOARD_RBAC) on or off, without a restart (superset_config.py). */
  dashboardRbac: (on: boolean) => void;
  /** A session signed in to Superset as this fixture user. */
  as: (user: string) => Promise<Session>;
  /**
   * Stops Lenspack and starts it again on the same port and state, with these lines added to its superset.yaml
   * (none: the suite's own config). Superset sessions stay signed in.
   */
  restartLenspack: (extraYaml?: string[]) => Promise<void>;
  stop: () => Promise<void>;
};

/** Starts the stack for one Superset version (an apache/superset image tag). */
export async function startStack(
  version: string,
  o: {
    lenspackEnv?: Record<string, string>;
    /** Variables for Superset's container (the plugin reads LENSPACK_PATH and LENSPACK_BRAND_NAME there). */
    supersetEnv?: Record<string, string>;
    /** Superset under a path of its host (SUPERSET_APP_ROOT, Superset 6.1). */
    appRoot?: string;
  } = {},
): Promise<Stack> {
  const appRoot = (o.appRoot ?? "").replace(/\/+$/, "");
  const tag = `lpacc-${version.replace(/\W/g, "")}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const dir = mkdtempSync(join(tmpdir(), "lenspack-access-suite-"));
  const secrets = { SUPERSET_SECRET_KEY: randomBytes(32).toString("hex"), POSTGRES_PASSWORD: randomBytes(16).toString("hex"), LP_USER_PASSWORD: randomBytes(16).toString("hex") };
  const [pgPort, ssPort, lpPort] = [await freePort(), await freePort(), await freePort()];
  const superset = `http://127.0.0.1:${ssPort}`;
  const lenspack = `http://127.0.0.1:${lpPort}`;
  const containers = [`${tag}-pg`, `${tag}-superset`];
  let child: ChildProcess | null = null;
  const stub = stubModel();
  const way = cutOff(superset);
  const servers = [stub.server, way.server];

  const stop = async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise((r) => child!.once("exit", r)), sleep(5000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    for (const s of servers) s.closeAllConnections?.(), s.close();
    docker(["rm", "-f", "-v", ...containers]);
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const stubPort = await listen(stub.server);
    const wayPort = await listen(way.server);
    let r = docker(
      ["run", "-d", "--rm", "--name", containers[0]!, "--label", LABEL, "-e", "POSTGRES_USER=lp", "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=data", "-p", `127.0.0.1:${pgPort}:5432`, "-v", `${join(here, "seed.sql")}:/docker-entrypoint-initdb.d/seed.sql:ro`, "postgres:16-alpine"],
      { POSTGRES_PASSWORD: secrets.POSTGRES_PASSWORD },
    );
    if (r.status) throw new Error(`Postgres did not start: ${r.stderr.trim()}`);
    const script = [
      "set -e",
      // The stock image has no Postgres driver for data (only for its own metadata, which here is SQLite).
      "uv pip install --python /app/.venv/bin/python -q psycopg2-binary",
      "superset db upgrade >/tmp/upgrade.log 2>&1 || { tail -40 /tmp/upgrade.log; exit 1; }",
      "superset init >/tmp/init.log 2>&1 || { tail -40 /tmp/init.log; exit 1; }",
      "python /access/fixtures.py >/tmp/fixtures.json 2>/tmp/fixtures.log || { tail -40 /tmp/fixtures.log; exit 1; }",
      'echo "LP_FIXTURES $(tail -1 /tmp/fixtures.json)"',
      "exec /usr/bin/run-server.sh",
    ].join("\n");
    r = docker(
      [
        "run", "-d", "--name", containers[1]!, "--label", LABEL, "--network", "host", "--user", "root",
        "-e", "SUPERSET_SECRET_KEY", "-e", "LP_USER_PASSWORD", "-e", "LP_DATA_URI",
        "-e", "SUPERSET_CONFIG_PATH=/access/superset_config.py", "-e", "PYTHONPATH=/plugin:/access",
        "-e", `LENSPACK_INTERNAL_URL=${lenspack}`, "-e", "SUPERSET_BIND_ADDRESS=127.0.0.1", "-e", `SUPERSET_PORT=${ssPort}`,
        "-e", "SERVER_THREADS_AMOUNT=20", "-e", "GUNICORN_TIMEOUT=120",
        ...(appRoot ? ["-e", `SUPERSET_APP_ROOT=${appRoot}`] : []),
        ...Object.entries(o.supersetEnv ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        "-v", `${plugin}:/plugin:ro`, "-v", `${here}:/access:ro`,
        `apache/superset:${version}`, "sh", "-c", script,
      ],
      { SUPERSET_SECRET_KEY: secrets.SUPERSET_SECRET_KEY, LP_USER_PASSWORD: secrets.LP_USER_PASSWORD, LP_DATA_URI: `postgresql://lp:${secrets.POSTGRES_PASSWORD}@127.0.0.1:${pgPort}/data` },
    );
    if (r.status) throw new Error(`Superset ${version} did not start: ${r.stderr.trim()}`);

    // Superset: migrations, init and the fixtures take a minute or two.
    let fixtures: Fixtures | null = null;
    for (const until = Date.now() + 600_000; !fixtures; ) {
      const logs = docker(["logs", containers[1]!]);
      const line = /^LP_FIXTURES (.+)$/m.exec(logs.stdout)?.[1];
      const state = docker(["inspect", "-f", "{{.State.Running}}", containers[1]!]).stdout.trim();
      if (state !== "true") throw new Error(`Superset ${version} stopped while starting:\n${(logs.stdout + logs.stderr).split("\n").slice(-40).join("\n")}`);
      if (line && (await http(superset, "GET", `${appRoot}/health`).catch(() => null))?.status === 200) fixtures = JSON.parse(line) as Fixtures;
      else if (Date.now() > until) throw new Error(`Superset ${version} was not up in 10 minutes`);
      else await sleep(2000);
    }

    // Lenspack, with nothing but what it needs in its environment: no model keys, and no host policy (the default is under test).
    const logFile = join(dir, "lenspack.log");
    const log = () => readFileSync(logFile, "utf8");
    const startLenspack = async (extraYaml: string[] = []) => {
      writeFileSync(
        join(dir, "superset.yaml"),
        [
          `superset: { url: "http://127.0.0.1:${wayPort}${appRoot}" }`,
          "datasets: [visits, stock]",
          `dashboards: [${fixtures!.dashboards.a}, ${fixtures!.dashboards.b}, ${fixtures!.dashboards.c}]`,
          `overlay: { pack: ${PACK} }`,
          "host: 127.0.0.1",
          `port: ${lpPort}`,
          "publicPath: /lenspack",
          `state: ${join(dir, "state", "superset-boards.json")}`,
          ...extraYaml,
          "",
        ].join("\n"),
      );
      const out = openSync(logFile, "a");
      // Ready once this start's own "listening" line is in the log, not an earlier start's.
      const from = (() => {
        try {
          return log().length;
        } catch {
          return 0;
        }
      })();
      const started = spawn(join(root, "node_modules", ".bin", "tsx"), ["--tsconfig", "tsconfig.base.json", "packages/hosts/superset/bin/serve.ts", join(dir, "superset.yaml")], {
        cwd: root,
        stdio: ["ignore", out, out],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          SUPERSET_ADMIN_USERNAME: "lp_admin",
          SUPERSET_ADMIN_PASSWORD: secrets.LP_USER_PASSWORD,
          LENSPACK_LLM_PROVIDERS: JSON.stringify([{ name: "stub", model: "stub", baseUrl: `http://127.0.0.1:${stubPort}/v1`, apiKey: "stub" }]),
          ...o.lenspackEnv,
        },
      });
      child = started;
      for (const until = Date.now() + 180_000; ; ) {
        if (started.exitCode !== null) throw new Error(`Lenspack exited while starting:\n${log().split("\n").slice(-30).join("\n")}`);
        if (log().slice(from).includes(`http://127.0.0.1:${lpPort}/`)) break;
        if (Date.now() > until) throw new Error(`Lenspack was not up in 3 minutes:\n${log().split("\n").slice(-30).join("\n")}`);
        await sleep(500);
      }
    };
    const stopLenspack = async () => {
      if (!child || child.exitCode !== null) return;
      const running = child;
      running.kill("SIGTERM");
      await Promise.race([new Promise((r) => running.once("exit", r)), sleep(5000)]);
      if (running.exitCode === null) {
        running.kill("SIGKILL");
        await new Promise((r) => running.once("exit", r));
      }
    };
    await startLenspack();

    const identityKey = createHmac("sha256", secrets.SUPERSET_SECRET_KEY).update("lenspack-identity-v1").digest("hex");
    return {
      version,
      appRoot,
      superset,
      lenspack,
      fixtures,
      identityKey,
      log,
      modelCalls: stub.calls,
      cut: way.cut,
      dashboardRbac: (on) => {
        const r = docker(["exec", containers[1]!, "sh", "-c", on ? "rm -f /tmp/lp-dashboard-rbac-off" : "touch /tmp/lp-dashboard-rbac-off"]);
        if (r.status) throw new Error(`could not turn dashboard roles ${on ? "on" : "off"}: ${r.stderr.trim()}`);
      },
      as: (user) => new Session(superset, user, appRoot).signIn(secrets.LP_USER_PASSWORD),
      restartLenspack: async (extraYaml = []) => {
        await stopLenspack();
        await startLenspack(extraYaml);
      },
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}
