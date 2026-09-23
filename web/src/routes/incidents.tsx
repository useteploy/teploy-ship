import { redirect } from "../lib/http.server.js";
// The incidents module is imported DIRECTLY from dist (no lib/*.server.ts
// re-export exists for it) — safe because src/incidents.ts is self-contained
// by construction: no value imports at all, so the client bundler never
// reaches node:fs through it. The one node-side value it needs, enqueueRun,
// stays behind the .server strip and is injected as a hook instead.
import {
  INCIDENT_ALERT_MAX,
  attributeIncident,
  createIncident,
  diagnoseIncident,
  listIncidents,
  sweepIncidents,
} from "../../../dist/incidents.js";
import type { IncidentRecord, IncidentStatus } from "../../../dist/incidents.js";
import { enqueueRun, actorFromPrincipal } from "../lib/ship.server.js";
import { shipRuntime, defaultModel } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";

export const config = { mode: "app" };

/**
 * S17 starter — the incident list, read-only end to end.
 *
 * Login-gated by the layout middleware (this path is on no exemption list).
 * Creating, attributing and diagnosing additionally take the steer grant
 * (`may("steer", me)`), the same authority the run page's interventions use:
 * all three launch or steer agent work, and a viewer may read but not commission.
 *
 * Diagnosis runs are `mode: "scan"` runs — the read-only guarantee lives in
 * the enqueue/loop/publish gates (see src/incidents.ts's header for the exact
 * locations), not on this page. This page renders findings and the bounded
 * proposal; it offers no remediation and no delivery, by design.
 */
export async function loader({ request }: { request: Request }): Promise<IncidentsData> {
  const runtime = await shipRuntime();
  // Opportunistic digest so incidents settle on view even where the worker
  // sweep wiring has not landed yet; sweepIncidents is idempotent and the
  // worker's own leg (see the integration note in src/incidents.ts) remains
  // the designated driver.
  await sweepIncidents({ config: runtime.config, store: runtime.store });
  const [incidents, canSteer] = await Promise.all([
    listIncidents(runtime.config),
    may("steer", await currentUser(request)),
  ]);
  const query = new URL(request.url).searchParams;
  return {
    incidents,
    canSteer,
    error: query.get("error"),
    notice: query.get("notice"),
  };
}

export interface IncidentsData {
  incidents: IncidentRecord[];
  canSteer: boolean;
  error: string | null;
  notice: string | null;
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const me = await currentUser(request);
  if (!(await may("steer", me))) return new Response("Not permitted", { status: 403 });
  const runtime = await shipRuntime();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  try {
    if (intent === "create") {
      const alertText = String(form.get("alertText") ?? "").trim();
      if (alertText === "") return redirect("/incidents?error=Paste+the+alert+text+first");
      const serviceHint = String(form.get("serviceHint") ?? "").trim();
      await createIncident(runtime.config, { alertText, ...(serviceHint !== "" ? { serviceHint } : {}) });
      return redirect("/incidents?notice=Incident+opened");
    }
    if (intent === "attribute") {
      const hint = String(form.get("serviceHint") ?? "").trim();
      await attributeIncident(
        { config: runtime.config, projects: runtime.projects },
        id,
        ...(hint !== "" ? [{ hint }] : []),
      );
      return redirect("/incidents");
    }
    if (intent === "diagnose") {
      const record = await diagnoseIncident(
        {
          config: runtime.config,
          enqueue: (options) => enqueueRun(runtime, options),
          model: defaultModel(),
          ...(me !== null ? { actor: actorFromPrincipal(me) } : {}),
        },
        id,
      );
      return redirect(`/incidents?notice=${encodeURIComponent(`Diagnosis run ${record.diagnosisRunId ?? ""} queued on ${record.attribution?.repo ?? "the attributed repo"}`)}`);
    }
    return redirect("/incidents?error=Unknown+action");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return redirect(`/incidents?error=${encodeURIComponent(detail.slice(0, 400))}`);
  }
}

const STATUS_CLASS: Record<IncidentStatus, string> = {
  new: "",
  attributed: "",
  "needs-attribution": "waiting",
  diagnosing: "queued",
  diagnosed: "completed",
  "diagnosis-failed": "failed",
};

function when(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

function StatusChip({ incident }: { incident: IncidentRecord }) {
  return <span class={`status ${STATUS_CLASS[incident.status]}`}>{incident.status}</span>;
}

type IncidentFinding = NonNullable<IncidentRecord["diagnosis"]>["findings"][number];

function Finding({ finding }: { finding: IncidentFinding }) {
  return (
    <li style="border-top:1px solid var(--border);padding:8px 0;margin:0">
      <p style="margin:0 0 4px">
        <span class={`chip${finding.severity === "high" ? " bad" : ""}`}>{finding.severity}</span>{" "}
        <strong style="font-weight:500">{finding.title}</strong>{" "}
        <code>{finding.file}{finding.line !== undefined ? `:${finding.line}` : ""}</code>
      </p>
      <p style="margin:0 0 4px;color:var(--text)">{finding.detail}</p>
      {finding.fix !== undefined && finding.fix !== "" && (
        <p style="margin:0" class="meta">Proposed fix (not implemented): {finding.fix}</p>
      )}
    </li>
  );
}

function Diagnosis({ incident, canSteer }: { incident: IncidentRecord; canSteer: boolean }) {
  if (incident.status === "diagnosing" && incident.diagnosisRunId !== undefined) {
    return (
      <p style="margin:8px 0 0">
        Read-only diagnosis running: <a href={`/runs/${encodeURIComponent(incident.diagnosisRunId)}`}>{incident.diagnosisRunId}</a>
      </p>
    );
  }
  const diagnosis = incident.diagnosis;
  if (diagnosis === undefined) {
    if (incident.failure !== undefined && incident.status === "diagnosis-failed") {
      return (
        <div style="margin:8px 0 0">
          <p class="notice bad" style="margin:0 0 6px">{incident.failure}</p>
          {incident.diagnosisRunId !== undefined && (
            <p class="meta" style="margin:0 0 6px">The failed run and its transcript remain at <a href={`/runs/${encodeURIComponent(incident.diagnosisRunId)}`}>{incident.diagnosisRunId}</a>.</p>
          )}
          {canSteer && (
            <form method="post">
              <input type="hidden" name="intent" value="diagnose" />
              <input type="hidden" name="id" value={incident.id} />
              <button type="submit" class="sm">Diagnose again</button>
            </form>
          )}
        </div>
      );
    }
    return null;
  }
  const u = diagnosis.uncertainty;
  return (
    <div style="margin:8px 0 0">
      <p style="margin:0 0 6px">
        Diagnosis from <a href={`/runs/${encodeURIComponent(diagnosis.runId)}`}>{diagnosis.runId}</a> —{" "}
        <span class={`chip${diagnosis.confidence === "low" ? " bad" : diagnosis.confidence === "high" ? " ok" : ""}`}>confidence {diagnosis.confidence}</span>
      </p>
      {u.escalates ? (
        <p class="notice bad" style="margin:0 0 6px">
          Reports uncertainty and escalates: {u.rationale}. A human decides what happens next; this page proposes nothing further.
        </p>
      ) : (
        <p class="meta" style="margin:0 0 6px">{u.rationale}.</p>
      )}
      {u.wouldRaise.length > 0 && (
        <p class="meta" style="margin:0 0 6px">Would raise confidence: {u.wouldRaise.join("; ")}.</p>
      )}
      <details class="disclosure" style="margin:6px 0">
        <summary>The write-up</summary>
        <pre style="margin:0;white-space:pre-wrap;word-break:break-word">{diagnosis.summary}</pre>
      </details>
      {diagnosis.findings.length > 0 && (
        <ul style="list-style:none;margin:6px 0;padding:0">
          {diagnosis.findings.map((f, i) => <Finding key={i} finding={f} />)}
        </ul>
      )}
      {diagnosis.proposalFiles.length > 0 && (
        <p class="meta" style="margin:6px 0 0">
          Bounded proposal scope (files a fix would touch; nothing is implemented): {diagnosis.proposalFiles.join(", ")}
        </p>
      )}
    </div>
  );
}

export default function Incidents({ data }: { data: IncidentsData }) {
  return (
    <>
      <div class="page-heading">
        <div>
          <h1 class="page">Incidents</h1>
          <p class="meta">Alert, attributed repository, read-only diagnosis with a bounded fix proposal. Nothing is remediated or delivered from here.</p>
        </div>
        <a href="/">Back to Inbox</a>
      </div>
      {data.error !== null && <p class="notice bad" role="alert">{data.error}</p>}
      {data.notice !== null && <p class="notice">{data.notice}</p>}

      {data.canSteer ? (
        <form method="post" class="card" style="margin:14px 0">
          <input type="hidden" name="intent" value="create" />
          <div class="field" style="margin-bottom:10px">
            <label for="alertText">Open an incident from an alert</label>
            <textarea id="alertText" name="alertText" rows={3} required maxLength={INCIDENT_ALERT_MAX} placeholder="Paste the alert: what fired, on which service, when, with what numbers"></textarea>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
            <div class="field" style="flex:1;min-width:220px">
              <label for="serviceHint">Observe service (optional, for attribution)</label>
              <input id="serviceHint" name="serviceHint" type="text" placeholder="e.g. fylun-web" />
            </div>
            <button type="submit">Open incident</button>
          </div>
          <p class="meta" style="margin:8px 0 0">Attribution matches the service against projects that declare an Observe service; zero or ambiguous matches park the incident rather than guessing a repo.</p>
        </form>
      ) : (
        <p class="meta">Opening and working incidents takes the steer grant; your account may read them.</p>
      )}

      {data.incidents.length === 0 && <p class="empty">No incidents yet.</p>}
      {data.incidents.map((incident) => (
        <article class="card" key={incident.id} style="margin:10px 0">
          <p style="margin:0 0 6px" class="row-actions">
            <StatusChip incident={incident} />
            <code>{incident.id}</code>
            <span class="meta">{when(incident.createdAt)}</span>
            {incident.serviceHint !== undefined && <span class="chip">hint: {incident.serviceHint}</span>}
          </p>
          <pre style="margin:0 0 8px;white-space:pre-wrap;word-break:break-word">{incident.alertText}</pre>

          {incident.attribution !== undefined ? (
            <p style="margin:0 0 6px">
              Attributed to <code>{incident.attribution.repo}</code> (Observe service <code>{incident.attribution.observeService}</code>).
            </p>
          ) : incident.attributionRefusal !== undefined ? (
            <div style="margin:0 0 6px">
              <p class="notice bad" style="margin:0 0 6px">
                Needs attribution: {incident.attributionRefusal.reason}. A wrong repo would produce a confident diagnosis of the wrong code, so this is held for a human.
              </p>
              {incident.attributionRefusal.candidates.length > 0 && (
                <table class="runs" style="margin:0 0 6px">
                  <thead><tr><th>Repo</th><th>Observe service</th></tr></thead>
                  <tbody>
                    {incident.attributionRefusal.candidates.map((c) => (
                      <tr key={c.repo}><td><code>{c.repo}</code></td><td><code>{c.observeService}</code></td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}

          <Diagnosis incident={incident} canSteer={data.canSteer} />

          {data.canSteer && (incident.status === "new" || incident.status === "needs-attribution") && (
            <form method="post" style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:8px">
              <input type="hidden" name="intent" value="attribute" />
              <input type="hidden" name="id" value={incident.id} />
              <div class="field" style="flex:1;min-width:200px">
                <label for={`hint-${incident.id}`}>Observe service (corrected, optional)</label>
                <input id={`hint-${incident.id}`} name="serviceHint" type="text" placeholder={incident.serviceHint ?? "name the exact service"} />
              </div>
              <button type="submit" class="sm">Attribute</button>
            </form>
          )}
          {data.canSteer && incident.status === "attributed" && (
            <form method="post" style="margin-top:8px">
              <input type="hidden" name="intent" value="diagnose" />
              <input type="hidden" name="id" value={incident.id} />
              <button type="submit">Start read-only diagnosis</button>
            </form>
          )}
        </article>
      ))}
      {data.incidents.length > 0 && (
        <p class="meta">Diagnosis runs are read-only scans: no branch is pushed, no pull request is opened, no fix is implemented. Turning a proposal into a change is a separate, explicitly authorized request.</p>
      )}
    </>
  );
}
