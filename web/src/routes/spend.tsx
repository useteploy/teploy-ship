import { utcDay } from "teploy-ship/runtime";
import type { SpendEntry } from "teploy-ship/runtime";

import { shipRuntime } from "../lib/store.server.js";

export const config = { mode: "app" };

interface SpendData {
  entries: SpendEntry[];
  today: string;
  dailyBudget: number;
}

export async function loader(): Promise<SpendData> {
  const runtime = await shipRuntime();
  const entries = await runtime.spend.list();
  const budget = Number(process.env.SHIP_DAILY_BUDGET_USD ?? "10");
  return { entries, today: utcDay(), dailyBudget: Number.isFinite(budget) ? budget : 10 };
}

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export default function Spend({ data }: { data: SpendData }) {
  // Today, per source, vs the daily cap.
  const todayBySource = new Map<string, number>();
  for (const e of data.entries) {
    if (e.day === data.today) todayBySource.set(e.source, (todayBySource.get(e.source) ?? 0) + e.amountUSD);
  }
  const todayTotal = [...todayBySource.values()].reduce((a, b) => a + b, 0);

  // Recent days, total across sources.
  const byDay = new Map<string, number>();
  for (const e of data.entries) byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.amountUSD);
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14);
  const allTotal = data.entries.reduce((a, b) => a + b.amountUSD, 0);
  const maxDay = Math.max(0.0001, ...days.map((d) => d[1]));

  return (
    <>
      <h1 class="page">Spend</h1>
      <p class="meta">
        Your API cost — no markup. Metered against the per-source daily cap the worker enforces
        (SHIP_DAILY_BUDGET_USD, default {usd(data.dailyBudget)}).
      </p>

      <h2 class="section">Today <span class="count">({data.today} · {usd(todayTotal)})</span></h2>
      {todayBySource.size === 0 ? (
        <p class="empty">No spend recorded today.</p>
      ) : (
        [...todayBySource.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([source, amount]) => {
            const pct = Math.min(100, (amount / data.dailyBudget) * 100);
            const over = amount >= data.dailyBudget;
            return (
              <div key={source} class="card">
                <div class="row-actions">
                  <span class="chip">{source}</span>
                  <span style="flex:1" />
                  <span class={over ? "" : "meta"} style={over ? "color:var(--red)" : ""}>
                    {usd(amount)} / {usd(data.dailyBudget)}{over ? " · at cap" : ""}
                  </span>
                </div>
                <div style="margin-top:8px;height:6px;background:var(--bg);border-radius:4px;overflow:hidden">
                  <div style={`height:100%;width:${pct}%;background:${over ? "var(--red)" : "var(--green)"}`} />
                </div>
              </div>
            );
          })
      )}

      <h2 class="section">Recent days <span class="count">(total {usd(allTotal)})</span></h2>
      {days.length === 0 ? (
        <p class="empty">No spend recorded yet.</p>
      ) : (
        <table class="runs">
          <thead>
            <tr><th>day</th><th style="width:60%">spend</th><th style="text-align:right">total</th></tr>
          </thead>
          <tbody>
            {days.map(([day, total]) => (
              <tr key={day}>
                <td class="meta">{day}{day === data.today ? " · today" : ""}</td>
                <td>
                  <div style="height:8px;background:var(--bg);border-radius:4px;overflow:hidden">
                    <div style={`height:100%;width:${(total / maxDay) * 100}%;background:var(--blue)`} />
                  </div>
                </td>
                <td style="text-align:right">{usd(total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
