import { shipRuntime } from "../lib/store.server.js";
import type { Thread, ReviewsData } from "./reviews.js";

export async function loader(): Promise<ReviewsData> {
  const runtime = await shipRuntime();
  const all = await runtime.intake.list();
  const reviews = all.filter((t) => t.kind === "review" && t.pr !== undefined);

  const byPr = new Map<string, Thread>();
  for (const t of reviews) {
    const key = `${t.repo ?? ""}#${t.pr}`;
    let th = byPr.get(key);
    if (th === undefined) {
      th = { key, pr: t.pr as number, ...(t.repo !== undefined ? { repo: t.repo } : {}), items: [], lastAt: t.createdAt };
      byPr.set(key, th);
    }
    th.items.push(t);
    if (t.createdAt > th.lastAt) th.lastAt = t.createdAt;
  }

  const threads = [...byPr.values()]
    .map((th) => ({ ...th, items: th.items.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)) }))
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));

  return { view: "reviews", threads, store: runtime.kind };
}

