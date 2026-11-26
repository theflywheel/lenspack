// A deployment that names the assistant (LENSPACK_BRAND_NAME on the assistant's server) and moves Superset's route
// for it (LENSPACK_PATH=/assistant on Superset's side): no page people open says the product's name, and nothing
// is served from /lenspack. Run with `pnpm test:access brand`.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PACK, type Session, type Stack, readChat, startStack } from "./stack";

const NAME = "Campaign desk";
const PATH = "/assistant";

/** What a person can read on a page: its text and the attributes a tooltip or screen reader shows, with names that are code taken out. */
function readable(html: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<code>[^<]*<\/code>/g, " ")
    .replace(/<[^>]*?\b(?:title|aria-label|placeholder|alt)="([^"]*)"[^>]*>/g, " $1 ")
    .replace(/<[^>]*>/g, " ");
  return text.replace(/\bLENSPACK_[A-Z0-9_]+\b/g, " ");
}

describe.sequential("Superset 6.1.0 with the assistant named and moved", () => {
  let stack: Stack;
  let admin: Session;
  let owner: Session;
  let A: number;

  beforeAll(async () => {
    stack = await startStack("6.1.0", { lenspackEnv: { LENSPACK_BRAND_NAME: NAME }, supersetEnv: { LENSPACK_PATH: PATH } });
    A = stack.fixtures.dashboards.a;
    admin = await stack.as("lp_admin");
    owner = await stack.as("lp_owner");
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("serves the route at LENSPACK_PATH only", async () => {
    expect((await owner.send("GET", "/lenspack/overlay.js")).status).toBe(404);
    expect((await owner.send("GET", `${PATH}/overlay.js`)).status).toBe(200);
    const page = await owner.send("GET", `/superset/dashboard/${A}/`);
    expect(page.text).toContain(`var base = "${PATH}";`);
  });

  it("tells the overlay its name, and the chat answers through the moved route", async () => {
    const info = await owner.send("GET", `${PATH}/_superset/info`);
    expect(info.json.brand.name).toBe(NAME);
    const turn = readChat(await owner.send("POST", `${PATH}/api/${PACK}/superset-${A}/chat?review=off`, { body: { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "TOOL list_metrics {}" }] }] } }));
    expect(turn.status, turn.error).toBe(200);
  });

  it("names Superset's menu entry after the assistant, asking its server in the background", async () => {
    // Nothing on Superset's side names it, and the settings page has not been opened: the first menu drawn asks the
    // server, and a later one says the name.
    await vi.waitFor(async () => expect((await admin.send("GET", "/superset/welcome/")).text).toContain(NAME), { timeout: 20_000, interval: 1000 });
  });

  it("names the settings page after the assistant, with no product name on the page", async () => {
    const settings = await admin.send("GET", "/ai-assistant/");
    expect(settings.status).toBe(200);
    expect(settings.text).toContain(`<h1>${NAME}</h1>`);
    // The page is the admin pages' script, given the assistant's name and the moved route.
    const shell = JSON.parse(/window\.__lpAdmin = (\{.*?\});<\/script>/.exec(settings.text)![1]!);
    expect(shell).toMatchObject({ name: NAME, api: { host: `${PATH}/_superset/` }, panelUrl: `${PATH}/_superset/admin/` });
    expect(readable(settings.text)).not.toMatch(/lenspack/i);
    expect(settings.text).toContain(`href="${PATH}/_superset/admin/"`);
    // The script itself names nothing: what people read comes from the server's brand.
    const script = await admin.send("GET", `${PATH}/_superset/admin/panel.js`);
    expect(script.status).toBe(200);
  });

  it("serves the admin panel and the server's own page without the product's name", async () => {
    const panel = await admin.send("GET", `${PATH}/_superset/admin/`);
    expect(panel.status).toBe(200);
    expect(readable(panel.text)).not.toMatch(/lenspack/i);
    const index = await owner.send("GET", `${PATH}/`);
    expect(index.status).toBe(200);
    expect(readable(index.text)).not.toMatch(/lenspack/i);
  });
});
