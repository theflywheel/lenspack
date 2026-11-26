// One way every admin list is paged: ?limit=N and an opaque ?cursor= (from the last answer's page.next or page.prev),
// or ?offset=N to jump to a page. Answers carry page: { offset, limit, total, next, prev }. A route that answered a
// plain list before still does when asked the old way; it pages once any of these is sent (pagedAsk).

export type PageInfo = { offset: number; limit: number; total: number; next: string | null; prev: string | null };
export type Paged<T> = { items: T[]; page: PageInfo };

const LIMITS = { default: 25, max: 200 };

/** The cursor for a list position. Opaque to callers: they send back what they were given. */
export const cursorAt = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString("base64url");

function offsetOf(cursor: string): number {
  try {
    const o = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { o?: unknown }).o;
    if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
  } catch {
    /* below */
  }
  throw new PageError("cursor is not one this server gave");
}

export class PageError extends Error {}

/** Whether a request asks for a page (any paging or filter parameter), rather than a route's older plain answer. */
export const pagedAsk = (url: URL, filters: readonly string[] = []) => ["cursor", "offset", "page", ...filters].some((k) => url.searchParams.has(k));

/** Where a page starts and how long it is, from ?cursor= / ?offset= and ?limit=. A bad cursor is a PageError (400). */
export function pageAsk(url: URL, o: { limit?: number; max?: number } = {}): { offset: number; limit: number } {
  const max = o.max ?? LIMITS.max;
  const limit = Math.max(1, Math.min(Math.floor(Number(url.searchParams.get("limit"))) || o.limit || LIMITS.default, max));
  const cursor = url.searchParams.get("cursor");
  const offset = cursor ? offsetOf(cursor) : Math.max(0, Math.floor(Number(url.searchParams.get("offset"))) || 0);
  return { offset, limit };
}

/** One page of a list already in order, with the cursors either side. */
export function pageOf<T>(all: readonly T[], ask: { offset: number; limit: number }): Paged<T> {
  const { offset, limit } = ask;
  const total = all.length;
  return {
    items: all.slice(offset, offset + limit),
    page: { offset, limit, total, next: offset + limit < total ? cursorAt(offset + limit) : null, prev: offset > 0 ? cursorAt(Math.max(0, offset - limit)) : null },
  };
}

/** A page of a list from a request: pageAsk then pageOf. */
export const pageFrom = <T>(all: readonly T[], url: URL, o?: { limit?: number; max?: number }) => pageOf(all, pageAsk(url, o));
