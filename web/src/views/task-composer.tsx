import { useEffect, useState } from "preact/hooks";
import { JOURNEYS, type Journey } from "teploy-ship/journeys";

export interface TaskProject { url: string; label: string; planSupported: boolean }
export function TaskComposer({ projects, selectedRepo, initialTask = "", initialJourney = "change", initialPlan = false, canLaunch, canRequest, requestId, clearDraft = false }: {
  projects: TaskProject[]; selectedRepo: string; initialTask?: string; initialJourney?: Journey; initialPlan?: boolean;
  canLaunch: boolean; canRequest: boolean; requestId: string; clearDraft?: boolean;
}) {
  const [journey, setJourney] = useState<Journey>(initialJourney);
  const [task, setTask] = useState(initialTask);
  const [repo, setRepo] = useState(selectedRepo || projects[0]?.url || "");
  const [pr, setPr] = useState("");
  const [plan, setPlan] = useState(initialPlan);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      if (clearDraft) sessionStorage.removeItem("ship-new-request");
      const raw = sessionStorage.getItem("ship-new-request");
      if (raw) {
        const draft = JSON.parse(raw);
        if ((draft.template ?? "") !== initialTask || (selectedRepo && draft.repo !== selectedRepo)) { setRestored(true); return; }
        if (typeof draft.pr === "string") setPr(draft.pr);
        if (typeof draft.plan === "boolean") setPlan(draft.plan);
        if (typeof draft.task === "string") setTask(draft.task);
        if (typeof draft.repo === "string" && projects.some(p => p.url === draft.repo)) setRepo(draft.repo);
        if (JOURNEYS.some(j => j.id === draft.journey)) setJourney(draft.journey);
      }
    } catch {}
    setRestored(true);
  }, []);
  const saveDraft = (patch: {task?: string; repo?: string; journey?: Journey; pr?: string; plan?: boolean}) => {
    try { sessionStorage.setItem("ship-new-request", JSON.stringify({ task, repo, journey, pr, plan, template: initialTask, ...patch })); } catch {}
  };
  const selected = projects.find(p => p.url === repo);
  const choice = JOURNEYS.find(j => j.id === journey)!;
  return <form class="composer" method="post" id="new-task" data-ready={restored ? "true" : "false"}>
    <input type="hidden" name="requestId" value={requestId} />
    <label class="field">Project<select name="repo" required value={repo} onChange={e => { setRepo(e.currentTarget.value); saveDraft({ repo: e.currentTarget.value }); }}>
      <option value="" disabled>Choose a project</option>
      {projects.map(p => <option key={p.url} value={p.url}>{p.label}</option>)}
    </select></label>
    {projects.length === 0 && <p class="notice">A project needs to be connected before you can request work. Ask your administrator to <a href="/setup">set up a project</a>.</p>}
    <fieldset class="task-choices"><legend>What would you like to do?</legend>{JOURNEYS.map(j => <label class={journey === j.id ? "task-choice selected" : "task-choice"} key={j.id}>
      <input type="radio" name="journey" value={j.id} checked={journey === j.id} onChange={() => { setJourney(j.id); saveDraft({ journey: j.id }); }} /><span><b>{j.label}</b><small>{j.description}</small></span>
    </label>)}</fieldset>
    <label htmlFor="task-prompt">Describe what you need</label>
    <textarea id="task-prompt" name="task" rows={4} maxLength={20000} required value={task} onInput={e => { setTask(e.currentTarget.value); saveDraft({ task: e.currentTarget.value }); }} placeholder={journey === "change" ? 'For example: Change “Start trial” to “Try it free” on the pricing page, keeping its current style.' : journey === "plan" ? "For example: How could we let customers download their invoices? Give me a plan first." : journey === "review" ? "For example: Check the signup flow for problems that could stop a new customer." : "For example: What happens when a customer cancels their subscription?"} />
    <p class="meta">Expected result: {choice.outcome}. You can describe this in everyday language.</p>
    <details class="disclosure"><summary>More options</summary>
      {journey === "review" && <label class="field">Pull request number (optional)<input type="number" name="pr" min="1" step="1" value={pr} onInput={e => { setPr(e.currentTarget.value); saveDraft({ pr: e.currentTarget.value }); }} placeholder="Review the project if left blank" /></label>}
      {journey === "change" && canLaunch && selected?.planSupported && <label class="check-field"><input type="checkbox" name="plan" checked={plan} onChange={e => { setPlan(e.currentTarget.checked); saveDraft({ plan: e.currentTarget.checked }); }} />Approve a plan before changes begin</label>}
      {journey === "change" && !selected?.planSupported && <p class="meta">To discuss an approach first, choose “Make a plan”, then request implementation when you are ready.</p>}
      <p class="meta">The project supplies the agent, environment and checks. <a href="/projects">Project settings</a></p>
    </details>
    <div class="composer-footer">
      {canLaunch && <button class="primary" type="submit" name="intent" value="new-run" disabled={!projects.length}>Start task</button>}
      {canRequest && <button type="submit" name="intent" value="submit-request" disabled={!projects.length}>Send for approval</button>}
      {!canRequest && !canLaunch && <p class="meta">Your account can follow work. Ask an administrator for permission to submit requests.</p>}
    </div>
    <p class="meta">{canLaunch ? "Starting a task uses the project’s configured permissions and budget." : "Sending a request does not start work or spend model budget. An authorized teammate reviews it first."}</p>
  </form>;
}
