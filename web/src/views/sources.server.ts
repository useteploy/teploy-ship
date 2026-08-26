import { shipRuntime } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";
import { autoAllowedNow, formatWindow, windowFor } from "../lib/ship.server.js";
import { redirect } from "../lib/http.server.js";
import type { SourcePolicy } from "teploy-ship/runtime";
import type { SourceRow, SourcesData } from "./sources.js";
import { KNOWN_SOURCES, POLICIES } from "./sources.js";

export async function loader({ request }: { request: Request }): Promise<SourcesData> {
  const runtime = await shipRuntime();
  const me = await currentUser(request);
  const [stored, proposed, governance, canEdit, canAuto] = await Promise.all([
    runtime.policies.list(),
    runtime.intake.list("proposed"),
    runtime.governance.get(),
    may("policies", me),
    may("auto", me),
  ]);
  const now = new Date();

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
    const w = windowFor(governance.windows, source);
    return {
      source,
      policy: p?.policy ?? "propose",
      ...(p?.dailyBudgetUSD !== undefined ? { dailyBudgetUSD: p.dailyBudgetUSD } : {}),
      seen: observed.has(source) || bySource.has(source),
      proposed: proposedCount.get(source) ?? 0,
      ...(w !== undefined ? { window: formatWindow(w), windowOpen: autoAllowedNow(governance.windows, source, now) } : {}),
    };
  });

  const hookBase = (process.env.SHIP_PUBLIC_URL ?? "").replace(/\/+$/, "");
  return { view: "sources", rows, store: runtime.kind, hookBase, canEdit, canAuto, denied: new URL(request.url).searchParams.get("denied") };
}


export async function action({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData();
  const source = String(form.get("source") ?? "").trim();
  if (source === "") return redirect("/projects?view=sources");
  const runtime = await shipRuntime();
  const me = await currentUser(request);

  const policyRaw = String(form.get("policy") ?? "propose");
  const policy = (POLICIES as readonly string[]).includes(policyRaw) ? (policyRaw as SourcePolicy["policy"]) : "propose";

  // Two grants (governance.ts): changing any policy needs `policies`; turning a
  // source to auto — unattended execution and spend — additionally needs
  // `auto`, unless the source already is auto and only its budget moved.
  if (!(await may("policies", me))) return redirect("/projects?view=sources&denied=policies");
  if (policy === "auto") {
    const current = (await runtime.policies.list()).find((p) => p.source === source)?.policy;
    if (current !== "auto" && !(await may("auto", me))) return redirect("/projects?view=sources&denied=auto");
  }

  const budgetRaw = String(form.get("budget") ?? "").trim();
  const budget = budgetRaw === "" ? undefined : Number(budgetRaw);
  const dailyBudgetUSD = budget !== undefined && Number.isFinite(budget) && budget > 0 ? budget : undefined;

  await runtime.policies.set({ source, policy, ...(dailyBudgetUSD !== undefined ? { dailyBudgetUSD } : {}) });
  return redirect("/projects?view=sources");
}

