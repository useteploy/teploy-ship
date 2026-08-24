import { utcDay } from "../lib/ship.server.js";
import type { SpendEntry, AttributedSpendEntry } from "teploy-ship/runtime";

import { shipRuntime } from "../lib/store.server.js";

export const config = { mode: "app" };

interface SpendData {
  entries: SpendEntry[];
  /** The same settled cost, cut by repo and by actor (see src/attributed-spend.ts). */
  attributed: AttributedSpendEntry[];
  today: string;
  dailyBudget: number;
  /** Server read time, epoch ms — the projection is computed against it, not the client clock. */
  nowMs: number;
}

export async function loader(): Promise<SpendData> {
  const runtime = await shipRuntime();
  const [entries, attributed] = await Promise.all([runtime.spend.list(), runtime.attributedSpend.list()]);
  const budget = Number(process.env.SHIP_DAILY_BUDGET_USD ?? "10");
  const now = new Date();
  return {
    entries,
    attributed,
    today: utcDay(now),
    dailyBudget: Number.isFinite(budget) ? budget : 10,
    nowMs: now.getTime(),
  };
}

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/** "YYYY-MM-DD" `days` away from `day`, in UTC — the whole page speaks UTC days. */
function dayOffset(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** key -> [today, last 7 days (today included)] for one attribution kind. */
function attributionRows(
  entries: AttributedSpendEntry[],
  kind: string,
  today: string,
): Array<[string, number, number]> {
  // A 7-day window that ENDS today: excluding today would hide the very day
  // the operator is looking at, and "last 7 days" reading as 8 columns of
  // history plus a separate today is a table nobody trusts.
  const since = dayOffset(today, -6);
  const byKey = new Map<string, [number, number]>();
  for (const e of entries) {
    if (e.kind !== kind || e.day < since) continue;
    const row = byKey.get(e.key) ?? [0, 0];
    if (e.day === today) row[0] += e.amountUSD;
    row[1] += e.amountUSD;
    byKey.set(e.key, row);
  }
  return [...byKey.entries()].map(([key, r]) => [key, r[0], r[1]] as [string, number, number]).sort((a, b) => b[2] - a[2]);
}

function AttributionTable({ rows, kindLabel }: { rows: Array<[string, number, number]>; kindLabel: string }) {
  if (rows.length === 0) return null;
  return (
    <table class="runs">
      <thead>
        <tr>
          <th>{kindLabel}</th>
          <th style="text-align:right">today</th>
          <th style="text-align:right">last 7 days</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, today, week]) => (
          <tr key={key}>
            <td class="meta">{key}</td>
            <td style="text-align:right">{today > 0 ? usd(today) : "—"}</td>
            <td style="text-align:right">{usd(week)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
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

  // Linear projection of today's spend to the end of the UTC day: spend so
  // far scaled by how much of the day has elapsed. Honest about what it is —
  // it is a rate, not a forecast: it cannot see that a run just started, or
  // that nobody works at 3am UTC.
  const msIntoDay = data.nowMs - Date.parse(`${data.today}T00:00:00Z`);
  // Not shown until an hour of the day has passed: ten cents at 00:02 UTC
  // extrapolates to $72, which is a number that only misleads.
  const projectable = msIntoDay >= 3_600_000;
  const projectedToday = projectable ? (todayTotal * 86_400_000) / msIntoDay : todayTotal;

  const repoRows = attributionRows(data.attributed, "repo", data.today);
  const actorRows = attributionRows(data.attributed, "actor", data.today);

  return (
    <>
      <h1 class="page">Spend</h1>
      <p class="meta">
        Your API cost — no markup, cut by source, repository, and who asked. Metered against the
        per-source daily cap the worker enforces (SHIP_DAILY_BUDGET_USD, default {usd(data.dailyBudget)}).
      </p>

      <h2 class="section">Today <span class="count">({data.today} · {usd(todayTotal)})</span></h2>
      {todayTotal > 0 && projectable && (
        <p class="meta" style="margin:0 0 8px">
          projected for today at current rate: {usd(projectedToday)} — projection, not a cap
        </p>
      )}
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
        <div class="table-wrap"><table class="runs">
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
        </table></div>
      )}

      <h2 class="section">By repository</h2>
      {repoRows.length === 0 ? (
        <p class="empty">No attributed spend recorded yet.</p>
      ) : (
        <AttributionTable rows={repoRows} kindLabel="repository" />
      )}

      <h2 class="section">By actor</h2>
      {actorRows.length === 0 ? (
        <p class="empty">No attributed spend recorded yet.</p>
      ) : (
        <AttributionTable rows={actorRows} kindLabel="actor" />
      )}
    </>
  );
}
