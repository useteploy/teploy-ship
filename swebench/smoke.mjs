// Infra smoke test for the Engine-API executor — no model, no API cost.
// Exercises exactly the seams that broke the old ssh-string executor:
// shell metacharacters in agent scripts, file writes (the old stdin
// hang), timeouts, and cwd handling.
//
// Usage: node smoke.mjs <ssh-host> <image>
import { containerExecutor } from "./container-executor.mjs";
import { connectViaSSH, startInstanceContainer } from "./docker-client.mjs";

const [, , sshHost, image] = process.argv;
if (!sshHost || !image) {
  console.error("usage: node smoke.mjs <ssh-host> <image>");
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const { docker, close } = await connectViaSSH(sshHost);
const container = await startInstanceContainer(docker, { image, name: "tgw-smoke" });
try {
  const e = containerExecutor({ container, workdir: "/testbed" });

  // 1. quoting torture: single/double quotes, $, backticks, newlines —
  //    exactly the class of script the old executor mangled
  const torture = await e.exec(`X='sq'; Y="dq"; echo "$X $Y \\$literal \`echo bt\`" && python -c "
s = 'multi\\'line'
print(f'py says: {s}')"`);
  check("quoting torture", torture.exitCode === 0 && torture.stdout.includes("sq dq $literal bt") && torture.stdout.includes("py says: multi'line"), JSON.stringify(torture));

  // 2. putFile (the old hang) with quotes and unicode, then run it
  await e.putFile("scratch/hello.py", `print("quotes ' \\" ok, unicode: ✓")\n`);
  const ran = await e.exec("python scratch/hello.py");
  check("putFile + run", ran.exitCode === 0 && ran.stdout.includes("unicode: ✓"), JSON.stringify(ran));

  // 3. getFile roundtrip
  const back = new TextDecoder().decode(await e.getFile("scratch/hello.py"));
  check("getFile roundtrip", back.includes("unicode: ✓"), back);
  const missing = await e.getFile("no/such/file.txt").then(() => "resolved", (err) => err.message);
  check("getFile missing errors", missing !== "resolved", missing);

  // 4. cwd option
  const cwd = await e.exec("pwd", { cwd: "scratch" });
  check("cwd option", cwd.stdout.trim() === "/testbed/scratch", cwd.stdout);

  // 5. timeout enforcement (must return in ~3s, not hang)
  const t0 = Date.now();
  const slow = await e.exec("sleep 30", { timeoutMs: 3000 });
  const elapsed = Date.now() - t0;
  check("timeout kills", slow.timedOut === true && elapsed < 15000, `timedOut=${slow.timedOut} elapsed=${elapsed}ms`);

  // 6. nonzero exit + stderr propagation
  const fail = await e.exec("echo warn >&2; exit 7");
  check("exit code + stderr", fail.exitCode === 7 && fail.stderr.includes("warn"), JSON.stringify(fail));

  // 7. constant git plumbing used by the harness
  const diff = await e.exec("cd /testbed && git diff HEAD -- . | head -1; true");
  check("git plumbing", diff.exitCode === 0, JSON.stringify(diff));
} finally {
  await container.remove({ force: true }).catch(() => {});
  close();
}

console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
