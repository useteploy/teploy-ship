import type { ShipRuntime, Project } from "teploy-ship/runtime";
export interface ReadinessCheck {
  name: string;
  state: "ready" | "attention" | "unknown";
  detail: string;
  href?: string;
}
/** Configuration and reachability are distinct: never report a credential as tested merely because it exists. */
export async function readiness(
  runtime: ShipRuntime,
  project: Project | null,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  try {
    await runtime.ping();
    checks.push({
      name: "Storage",
      state: "ready",
      detail: "Ship can reach its run store.",
    });
  } catch {
    checks.push({
      name: "Storage",
      state: "attention",
      detail: "The run store did not respond. Check the service connection.",
      href: "/settings?view=system",
    });
  }
  checks.push({
    name: "Repository",
    state: project ? "ready" : "attention",
    detail: project
      ? `${project.label ?? project.repo} is registered. Clone access has not been tested by this check.`
      : "Register the clone URL and repository name to continue.",
    href: project
      ? `/projects?repo=${encodeURIComponent(project.repo)}`
      : "/projects#add-project",
  });
  const image = project?.sandboxImage || process.env.SHIP_SANDBOX_IMAGE;
  checks.push({
    name: "Execution environment",
    state: image ? "ready" : "attention",
    detail: image
      ? `Image: ${image}. ${project?.sandboxImage ? "Project override" : "Worker default"}. Image availability is verified when the worker starts a run.`
      : "Choose a sandbox image in project settings or configure a worker default.",
    href: project
      ? `/projects?repo=${encodeURIComponent(project.repo)}`
      : "/settings?view=models",
  });
  const command =
    project?.verification?.tests ||
    project?.testCommand ||
    process.env.SHIP_TEST_COMMAND;
  checks.push({
    name: "Tests",
    state: command ? "ready" : "unknown",
    detail: command
      ? `Configured: ${command}`
      : "No explicit test command. Ship will try repository detection at enqueue; review the first run’s evidence.",
    href: project
      ? `/projects?repo=${encodeURIComponent(project.repo)}`
      : "/projects",
  });
  checks.push({
    name: "Preview & browser verification",
    state: project?.verification?.preview ? "ready" : "unknown",
    detail: project?.verification?.preview
      ? "Preview target configured. A real run must prove deployment, smoke checks and browser flow."
      : "No project preview target configured. Add one to review the running app and browser evidence.",
    href: project
      ? `/projects?repo=${encodeURIComponent(project.repo)}`
      : "/projects",
  });
  checks.push({
    name: "Credentials & first run",
    state: "unknown",
    detail:
      "Worker credentials are deliberately not exposed to the dashboard. Run a read-only repository review to test checkout and model execution; inspect its outcome before requesting code changes.",
    href: project
      ? `/?workflow=review&repo=${encodeURIComponent(project.url ?? project.repo)}#new-task`
      : "/workflows",
  });
  return checks;
}
