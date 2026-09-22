import { createHash } from "node:crypto";

/** Stable identity scoped to an authenticated actor and submission surface. */
export function submissionIdentity(actor: string, scope: string, requestId: unknown, content: unknown) {
  if (typeof requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId)) {
    throw new Error("Refresh the page before sending your request.");
  }
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    runId: `run-request-${hash([actor,scope,requestId])}`,
    requestIdentity: hash([actor,scope,requestId,content]),
  };
}
