// AgentExecutor over the Docker Engine API (see docker-client.mjs for
// why: argv-array exec and tar-based file transfer structurally remove
// the shell-quoting and stdin-EOF failure modes of the old ssh-string
// executor). The agent's bash action is passed as ONE argv element to
// `bash -lc` — Docker delivers it verbatim; we never build shell strings
// around dynamic content.
import { pack as tarPack, extract as tarExtract } from "tar-stream";

import { execCollect } from "./docker-client.mjs";

export function containerExecutor({ container, workdir = "/testbed" }) {
  const absolute = (path) => (path.startsWith("/") ? path : `${workdir}/${path}`);

  return {
    async exec(command, options = {}) {
      const cwd = options.cwd !== undefined ? absolute(options.cwd) : workdir;
      return execCollect(container, ["bash", "-lc", command], {
        workingDir: cwd,
        timeoutMs: options.timeoutMs ?? 120000,
        ...(options.maxOutputBytes !== undefined ? { maxBytes: options.maxOutputBytes } : {}),
      });
    },

    async putFile(path, data) {
      const abs = absolute(path);
      const body = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
      const archive = tarPack();
      // Entry named with the full path relative to /; extraction creates
      // intermediate directories.
      archive.entry({ name: abs.replace(/^\//, ""), mode: 0o644 }, body);
      archive.finalize();
      const chunks = [];
      for await (const chunk of archive) chunks.push(chunk);
      await container.putArchive(Buffer.concat(chunks), { path: "/" });
    },

    async getFile(path) {
      const abs = absolute(path);
      let stream;
      try {
        stream = await container.getArchive({ path: abs });
      } catch (error) {
        throw new Error(`No such file: ${path} (${error.message})`);
      }
      const extractor = tarExtract();
      const found = new Promise((resolve, reject) => {
        let buffer;
        extractor.on("entry", (header, entryStream, next) => {
          const chunks = [];
          entryStream.on("data", (chunk) => chunks.push(chunk));
          entryStream.on("end", () => {
            if (header.type === "file" && buffer === undefined) buffer = Buffer.concat(chunks);
            next();
          });
          entryStream.resume();
        });
        extractor.on("finish", () => resolve(buffer));
        extractor.on("error", reject);
      });
      stream.pipe(extractor);
      const buffer = await found;
      if (buffer === undefined) throw new Error(`No such file: ${path}`);
      return new Uint8Array(buffer);
    },

    // Container lifecycle belongs to the harness (run-inference), not the executor.
    async destroy() {},
  };
}
