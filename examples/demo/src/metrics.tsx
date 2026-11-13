import * as React from "react";

import type { Catalogue } from "@lenspack/core";
import { ArrowLeft, Search } from "lucide-react";

import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";

type Pack = { description?: string; instructions?: string; catalogue: Catalogue };
type Item = { key: string; label: string; entity: string; hint?: string; synonyms?: string[]; detail: string };

const FORMAT: Record<string, string> = { number: "count or number", percent: "percentage", currency: "amount", compact: "number", duration: "seconds" };
const TYPE: Record<string, string> = { enum: "categories", string: "text", number: "number", boolean: "yes or no", time: "time" };
const titleCase = (key: string) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

// The pack's vocabulary in plain words, for people: the same keys, labels and
// meanings the chat assistant is given, so what you read here is what it knows.
export function MetricsReference({ example, load, onClose }: { example: string; load: (path: string) => Promise<any>; onClose: () => void }) {
  const [pack, setPack] = React.useState<Pack | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    void load(`/${example}`).then((r) => (r.catalogue ? setPack(r) : setProblem(r.error ?? "The pack did not load")));
  }, [example, load]);

  if (problem) return <p className="text-sm text-destructive">{problem}</p>;
  if (!pack) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const c = pack.catalogue;
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (x: Item) => {
    const text = [x.key, x.label, x.hint ?? "", ...(x.synonyms ?? [])].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const measures: Item[] = c.measures.filter((m) => m.verified).map((m) => ({ ...m, detail: FORMAT[m.format] ?? m.format }));
  const dimensions: Item[] = c.dimensions
    .filter((d) => d.verified)
    .map((d) => ({ ...d, detail: d.type === "time" && d.grains ? `time, by ${d.grains.join(", ")}` : (TYPE[d.type] ?? d.type) }));
  const shown = (xs: Item[], entity: string) => xs.filter((x) => x.entity === entity && matches(x));
  const total = measures.length + dimensions.length;
  const found = measures.filter(matches).length + dimensions.filter(matches).length;

  return (
    <div className="max-w-4xl space-y-6" data-testid="metrics-reference">
      <div className="space-y-2">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onClose}>
          <ArrowLeft /> Back to the board
        </Button>
        <h1 className="font-mono text-lg font-semibold tracking-[-0.02em] text-foreground">Metrics and dimensions</h1>
        <p className="max-w-[70ch] text-sm text-muted-foreground">
          Everything a board can show. Numbers (measures) are what gets counted; dimensions are the ways to split, filter or order them. The chat assistant reads this
          same list, so asking in these words gets you these numbers.
        </p>
      </div>

      {(pack.description || pack.instructions) && (
        <section className="space-y-3 rounded-md border border-rule bg-card p-4 text-sm">
          {pack.description && (
            <div>
              <h2 className="mb-1 font-medium text-foreground">About this data</h2>
              <p className="max-w-[80ch] text-body">{pack.description}</p>
            </div>
          )}
          {pack.instructions && (
            <div>
              <h2 className="mb-1 font-medium text-foreground">What to keep in mind</h2>
              <p className="max-w-[80ch] whitespace-pre-line text-body">{pack.instructions}</p>
            </div>
          )}
        </section>
      )}

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or meaning" className="pl-8" aria-label="Search metrics" />
        {words.length > 0 && <p className="mt-1 text-xs text-muted-foreground">{found} of {total} match</p>}
      </div>

      {c.entities.map((e) => {
        const ms = shown(measures, e.key);
        const ds = shown(dimensions, e.key);
        if (!ms.length && !ds.length) return null;
        return (
          <section key={e.key} className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">{titleCase(e.key)}</h2>
              {e.grain && <p className="text-xs text-muted-foreground">{e.grain.replace(/^./, (ch) => ch.toUpperCase())}.</p>}
            </div>
            {ms.length > 0 && <Group title="Numbers" items={ms} />}
            {ds.length > 0 && <Group title="Split, filter or order by" items={ds} />}
          </section>
        );
      })}
      {words.length > 0 && found === 0 && <p className="text-sm text-muted-foreground">Nothing matches. Ask the chat in your own words: it may know it by another name.</p>}
    </div>
  );
}

function Group({ title, items }: { title: string; items: Item[] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      <dl className="divide-y divide-rule rounded-md border border-rule bg-card">
        {items.map((x) => (
          <div key={x.key} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:gap-4">
            <dt className="min-w-0">
              <div className="text-sm font-medium text-foreground">{x.label}</div>
              <div className="truncate text-2xs text-muted-foreground">
                <span className="key">{x.key}</span> · {x.detail}
              </div>
            </dt>
            <dd className="min-w-0 text-sm text-body">
              {x.hint ?? <span className="text-muted-foreground">No description yet.</span>}
              {x.synonyms?.length ? <span className="block text-2xs text-muted-foreground">Also called: {x.synonyms.join(", ")}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
