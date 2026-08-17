// Docker Engine API access for the SWE-bench harness, replacing the
// former ssh-shell-string approach. The daemon on the eval box is reached
// through an SSH-forwarded Unix socket (system ssh, existing keys — no
// TCP exposure, no extra auth machinery), and every operation is a real
// API call: exec takes argv arrays (nothing is ever assembled into a
// shell string by us), files move as tar archives (no stdin pipes to
// hang on EOF). This kills both bug classes the string executor hit:
// remote-shell re-tokenization and the `docker exec -i` cat-EOF hang.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import Docker from "dockerode";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Forward the remote Docker socket locally and connect dockerode to it. */
export async function connectViaSSH(sshHost) {
  const dir = mkdtempSync(join(tmpdir(), "tgw-docker-"));
  const sock = join(dir, "docker.sock");
  const tunnel = spawn(
    "ssh",
    [
      "-nNT",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=5",
      "-o", "ServerAliveCountMax=3",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "StreamLocalBindUnlink=yes",
      "-L", `${sock}:/var/run/docker.sock`,
      sshHost,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  tunnel.stderr.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 15000;
  while (!existsSync(sock)) {
    if (tunnel.exitCode !== null) throw new Error(`ssh tunnel exited early: ${stderr.trim()}`);
    if (Date.now() > deadline) {
      tunnel.kill();
      throw new Error(`docker socket tunnel never came up: ${stderr.trim()}`);
    }
    await sleep(150);
  }

  const docker = new Docker({ socketPath: sock });
  await docker.ping();
  return {
    docker,
    close: () => {
      tunnel.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Pull an image if it is not already on the host.
 *
 * createContainer does NOT pull — it 404s on a missing image — so a sweep over
 * instances the host has never seen died on the first one. The 3-instance
 * gauge hid this because those images had been pulled by hand.
 *
 * Progress is logged per layer-set rather than silently: these are 1-2 GB
 * images and a run that looks hung for four minutes is otherwise
 * indistinguishable from a broken one.
 */
export async function ensureImage(docker, image, { attempts = 4, baseDelayMs = 15000 } = {}) {
  const have = await docker.getImage(image).inspect().then(() => true).catch(() => false);
  if (have) return;

  // Retried, because the failure this guards is TRANSIENT and has now cost
  // real work twice. The docker daemon resolves registry hostnames through the
  // HOST's resolv.conf — daemon.json's `dns` key configures CONTAINER
  // resolution, not the daemon's own pulls — and on a Tailscale host that
  // resolv.conf is MagicDNS only, with no public fallback. When MagicDNS
  // wobbles the pull fails with a 500 "server misbehaving", and it resolves
  // again minutes later on its own. It killed a 50-instance scoring pass
  // (25 instances scored as errors) and later a 50-instance inference sweep at
  // instance 46, losing 45 completed instances of work.
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    console.error(`  pulling ${image} …${attempt > 1 ? ` (attempt ${attempt}/${attempts})` : ""}`);
    const started = Date.now();
    try {
      await new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (doneErr) => (doneErr ? reject(doneErr) : resolve()));
        });
      });
      console.error(`  pulled in ${Math.round((Date.now() - started) / 1000)}s`);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts) break;
      const delay = baseDelayMs * attempt; // linear backoff: 15s, 30s, 45s
      console.error(`  pull failed (${message.slice(0, 140)}) — retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

/** Fresh long-lived container from an instance image (removing any stale one). */
export async function startInstanceContainer(docker, { image, name }) {
  await ensureImage(docker, image);
  await docker.getContainer(name).remove({ force: true }).catch(() => {});
  const container = await docker.createContainer({
    Image: image,
    name,
    Cmd: ["sleep", "infinity"],
    Tty: false,
  });
  await container.start();
  return container;
}

/**
 * Run an argv command in a container and collect its output. The wall
 * clock is enforced in-container via coreutils `timeout` (present in the
 * SWE-bench Ubuntu images); a generous local backstop destroys the
 * stream if even that fails, so nothing can hang the harness again.
 */
export async function execCollect(container, cmd, { workingDir, timeoutMs = 120000, maxBytes = 16 * 1024 * 1024 } = {}) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const wrapped = ["timeout", "-k", "5", String(seconds), ...cmd];

  let exec;
  let stream;
  try {
    exec = await container.exec({
      Cmd: wrapped,
      AttachStdout: true,
      AttachStderr: true,
      ...(workingDir !== undefined ? { WorkingDir: workingDir } : {}),
    });
    stream = await exec.start({ hijack: true, stdin: false });
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `exec failed to start: ${error.message}`, timedOut: false, truncated: false };
  }

  const stdout = collector(maxBytes);
  const stderr = collector(maxBytes);
  container.modem.demuxStream(stream, stdout.writable, stderr.writable);

  let backstopHit = false;
  const backstop = setTimeout(() => {
    backstopHit = true;
    stream.destroy();
  }, timeoutMs + 20000);
  backstop.unref?.();

  await new Promise((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", resolve);
  });
  clearTimeout(backstop);

  let exitCode = -1;
  for (let i = 0; i < 40; i++) {
    const info = await exec.inspect().catch(() => null);
    if (info && info.Running === false) {
      exitCode = info.ExitCode ?? -1;
      break;
    }
    await sleep(50);
  }

  // coreutils timeout exits 124 when the deadline fired
  const timedOut = backstopHit || exitCode === 124;
  return {
    exitCode: timedOut ? -1 : exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    timedOut,
    truncated: stdout.truncated || stderr.truncated,
  };
}

function collector(maxBytes) {
  let text = "";
  let truncated = false;
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      if (text.length < maxBytes) {
        const s = chunk.toString("utf8");
        const room = maxBytes - text.length;
        if (s.length > room) {
          text += s.slice(0, room);
          truncated = true;
        } else {
          text += s;
        }
      } else {
        truncated = true;
      }
      callback();
    },
  });
  return {
    writable,
    get text() {
      return text;
    },
    get truncated() {
      return truncated;
    },
  };
}
