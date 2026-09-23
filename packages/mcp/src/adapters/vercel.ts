import type { Tool } from "../tools";

// The shape the Vercel AI SDK's `tool()` accepts, produced without importing
// it: { description, inputSchema, execute } keyed by name. Spread the result
// into `tools:` on generateText / streamText.
export function toVercelAI(tools: Tool[]) {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema,
        // A thrown error would end the turn; a returned one lets the model retry.
        execute: async (args: unknown) => {
          try {
            return await t.execute(args as never);
          } catch (e) {
            return { applied: false, ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        },
      },
    ]),
  );
}
