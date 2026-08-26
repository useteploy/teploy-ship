import { utcDay } from "../lib/ship.server.js";
import { shipRuntime } from "../lib/store.server.js";
import type { SpendData } from "./spend.js";

export async function loader(): Promise<SpendData> {
  const runtime = await shipRuntime();
  const [entries, attributed, unpriced] = await Promise.all([runtime.spend.list(), runtime.attributedSpend.list(), runtime.unpricedRuns.list()]);
  const budget = Number(process.env.SHIP_DAILY_BUDGET_USD ?? "10");
  const now = new Date();
  return {
    view: "spend",
    entries,
    attributed,
    unpriced,
    today: utcDay(now),
    dailyBudget: Number.isFinite(budget) ? budget : 10,
    nowMs: now.getTime(),
  };
}

