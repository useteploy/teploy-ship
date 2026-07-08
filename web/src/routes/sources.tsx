import { shipRuntime } from "../lib/store.server.js";
import type { SourcePolicy } from "teploy-ship/runtime";

export const config = { mode: "app" };

// Sources Ship knows how to receive from, even before one has fired — so the
// operator can set a policy ahead of the first webhook.
const KNOWN_SOURCES = ["forgejo", "github", "manual"];
const POLICIES = ["ignore", "propose", "auto"] as const;

interface SourceRow extends SourcePolicy {
  seen: boolean; // has a task actually arrived from this source?
  proposed: number;
}

interface SourcesData {
  rows: SourceRow[];
  store: string;
  hookBase: string;
}

export async function loader(): Promise<SourcesData> {
  const runtime = await shipRuntime();
  const [stored, proposed] = await Promise.all([runtime.policies.list(), runtime.intake.list("proposed")]);

  const bySource = new Map<string, SourcePolicy>();
  for (const p of stored) bySource.set(p.source, p);

  const proposedCount = new Map<string, number>();
  const observed = new Set<string>();
  for (const t of proposed) {
    observed.add(t.source);
    proposedCount.set(t.source, (proposedCount.get(t.source) ?? 0) + 1);
  }

  const names = new Set<string>([...KNOWN_SOURCES, ...bySource.keys(), ...observed]);
  const rows: SourceRow[] = [...names].sort().map((source) => {
    const p = bySource.get(source);
    return {
      source,
      policy: p?.policy ?? "propose",
      ...(p?.dailyBudgetUSD !== undefined ? { dailyBudgetUSD: p.dailyBudgetUSD } : {}),
      seen: observed.has(source) || bySource.has(source),
      proposed: proposedCount.get(source) ?? 0,
    };
  });

  const hookBase = (process.env.SHIP_PUBLIC_URL ?? "").replace(/\/+$/, "");
  return { rows, store: runtime.kind, hookBase };
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData();
  const source = String(form.get("source") ?? "").trim();
  if (source === "") return redirect("/sources");
  const runtime = await shipRuntime();

  const policyRaw = String(form.get("policy") ?? "propose");
  const policy = (POLICIES as readonly string[]).includes(policyRaw) ? (policyRaw as SourcePolicy["policy"]) : "propose";

  const budgetRaw = String(form.get("budget") ?? "").trim();
  const budget = budgetRaw === "" ? undefined : Number(budgetRaw);
  const dailyBudgetUSD = budget !== undefined && Number.isFinite(budget) && budget > 0 ? budget : undefined;

  await runtime.policies.set({ source, policy, ...(dailyBudgetUSD !== undefined ? { dailyBudgetUSD } : {}) });
  return redirect("/sources");
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function badge(policy: string): { cls: string; text: string } {
  if (policy === "auto") return { cls: "status", text: "auto" };
  if (policy === "ignore") return { cls: "meta", text: "ignore" };
  return { cls: "chip", text: "propose" };
}

export default function Sources({ data }: { data: SourcesData }) {
  return (
    <>
      <h1 class="page">Sources & policies</h1>
      <p class="meta">
        What happens to an incoming task, per source. <b>ignore</b> drops it · <b>propose</b> queues it for your
        approval in the Inbox · <b>auto</b> launches it immediately (bounded by the source's daily budget). · store: {data.store}
        {data.store === "file" && " · file store has no worker — auto has no effect here"}
      </p>

      {data.rows.map((r) => {
        const b = badge(r.policy);
        return (
          <div key={r.source} class={`card${r.policy === "auto" ? " attn" : ""}`}>
            <form method="post" class="row-actions" style="flex-wrap:wrap;gap:12px;align-items:center">
              <input type="hidden" name="source" value={r.source} />
              <span class="chip" style="min-width:72px">{r.source}</span>
              <span class={b.cls}>{b.text}</span>
              {r.proposed > 0 && <span class="count">{r.proposed} proposed</span>}
              {!r.seen && <span class="meta">no tasks yet</span>}
              <span style="flex:1" />
              <label class="meta">
                policy{" "}
                <select name="policy" style="margin-left:4px">
                  {POLICIES.map((p) => (
                    <option key={p} value={p} selected={p === r.policy}>{p}</option>
                  ))}
                </select>
              </label>
              <label class="meta">
                daily $
                <input
                  type="number"
                  name="budget"
                  min="0"
                  step="0.5"
                  placeholder="default"
                  value={r.dailyBudgetUSD !== undefined ? String(r.dailyBudgetUSD) : ""}
                  style="width:88px;margin-left:4px"
                />
              </label>
              <button class="approve sm" type="submit">Save</button>
            </form>
          </div>
        );
      })}

      <h2 class="section">Add a source</h2>
      <div class="card">
        <form method="post" class="row-actions" style="flex-wrap:wrap;gap:12px;align-items:center">
          <input type="text" name="source" placeholder="source name, e.g. gitlab" style="min-width:180px" />
          <label class="meta">
            policy{" "}
            <select name="policy" style="margin-left:4px">
              {POLICIES.map((p) => (
                <option key={p} value={p} selected={p === "propose"}>{p}</option>
              ))}
            </select>
          </label>
          <label class="meta">
            daily $<input type="number" name="budget" min="0" step="0.5" placeholder="default" style="width:88px;margin-left:4px" />
          </label>
          <button class="approve sm" type="submit">Add</button>
        </form>
      </div>

      <h2 class="section">Webhook endpoints</h2>
      <p class="meta">
        Point your git host's webhook here and label an issue/PR <code>ship</code>. The label is the trigger; this
        page decides what the labeled task becomes.
      </p>
      <table class="runs">
        <thead>
          <tr><th>source</th><th>webhook path</th></tr>
        </thead>
        <tbody>
          <tr><td class="chip">forgejo</td><td class="meta">{data.hookBase || "<server-url>"}/hooks/forgejo</td></tr>
          <tr><td class="chip">github</td><td class="meta">{data.hookBase || "<server-url>"}/hooks/github</td></tr>
        </tbody>
      </table>
      {data.hookBase === "" && (
        <p class="meta" style="margin-top:8px">Set <code>SHIP_PUBLIC_URL</code> to show the full webhook URLs here.</p>
      )}
    </>
  );
}
