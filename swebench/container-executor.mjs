import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * An AgentExecutor that drives commands inside a running Docker container
 * on a remote host, over SSH. Purpose-built for the SWE-bench gauge: the
 * repo lives at /testbed in the container, so exec/file ops are rooted
 * there. (teploy-sandbox's daemon confines to /work; a production
 * SWE-bench-through-sandbox path would add an arbitrary-workdir option —
 * noted, out of scope for a 3-task gauge.)
 */
export function containerExecutor({ ssh, container, workdir = "/testbed" }) {
  const dockerExec = async (argv, { input, timeoutMs } = {}) => {
    // ssh <host> docker exec [-i] <container> sh -c '<cmd>' — cmd is passed
    // as a single argv, so no extra shell quoting on our side.
    const args = [ssh, "docker", "exec", ...(input !== undefined ? ["-i"] : []), container, ...argv];
    try {
      const { stdout, stderr } = await run("ssh", args, {
        ...(input !== undefined ? { input } : {}),
        maxBuffer: 16 * 1024 * 1024,
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      if (error.killed) return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: -1, timedOut: true };
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", exitCode: typeof error.code === "number" ? error.code : 1 };
    }
  };

  return {
    async exec(command, options = {}) {
      const cwd = options.cwd ? `${workdir}/${options.cwd}` : workdir;
      const full = `cd ${shq(cwd)} && ${command}`;
      const r = await dockerExec(["bash", "-lc", full], { timeoutMs: options.timeoutMs ?? 120000 });
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut === true, truncated: false };
    },
    async putFile(path, data) {
      const abs = path.startsWith("/") ? path : `${workdir}/${path}`;
      const body = typeof data === "string" ? data : Buffer.from(data);
      const r = await dockerExec(["bash", "-lc", `mkdir -p "$(dirname ${shq(abs)})" && cat > ${shq(abs)}`], { input: body });
      if (r.exitCode !== 0) throw new Error(`putFile ${path}: ${r.stderr}`);
    },
    async getFile(path) {
      const abs = path.startsWith("/") ? path : `${workdir}/${path}`;
      const r = await dockerExec(["cat", abs]);
      if (r.exitCode !== 0) throw new Error(`getFile ${path}: ${r.stderr}`);
      return new TextEncoder().encode(r.stdout);
    },
    async destroy() {},
  };
}

function shq(s) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
