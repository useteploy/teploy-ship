// Throw resource responses for compatibility with Neutron dev, which otherwise tries to render them.
import { shipRuntime } from "../../../lib/store.server.js";
import { currentUser, type Principal } from "../../../lib/session.server.js";
import { mayViewArtifact } from "../../../lib/run-access.server.js";
export const config = { mode: "app" };
export async function loader({
  request,
  params,
  mayView,
}: {
  request: Request;
  params: { id: string };
  /** Tests only: stands in for run-access mayViewRun. */
  mayView?: (user: Principal, runId: string) => Promise<boolean>;
}): Promise<Response> {
  const user = await currentUser(request);
  if (!user) throw new Response("Unauthorized", { status: 401 });
  const artifact = await (await shipRuntime()).artifacts?.get(params.id);
  if (!artifact || !(await mayViewArtifact(user, artifact, mayView)))
    throw new Response("Artifact not found", { status: 404 });
  const bytes = Buffer.from(artifact.data, "base64");
  const headers: Record<string, string> = {
    "content-type": artifact.mime,
    "content-disposition": `inline; filename="${artifact.name}"`,
    // Never cached: a demoted or removed user must not keep watching.
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  };
  const range = request.headers.get("range");
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(m?.[1]),
      end = m?.[2]
        ? Math.min(Number(m[2]), bytes.length - 1)
        : bytes.length - 1;
    if (
      !m ||
      !Number.isSafeInteger(start) ||
      start > end ||
      start >= bytes.length
    )
      throw new Response(null, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${bytes.length}` },
      });
    throw new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
        "content-length": String(end - start + 1),
      },
    });
  }
  throw new Response(bytes, {
    headers: { ...headers, "content-length": String(bytes.length) },
  });
}
