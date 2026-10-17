/**
 * View model for the run page's live view (D5). Pure, so the wording and
 * the diff line classes are pinned by tests rather than by eyeballing.
 */

export interface LiveOutputShape {
  command: string;
  turn?: number;
  startedAt: string;
  lastChunkAt: string;
  at: string;
  running: boolean;
  exitCode?: number;
  timedOut?: boolean;
  output: string;
  truncated: boolean;
}

export interface LiveDiffShape {
  at: string;
  sandboxAt?: string;
  head?: string;
  base?: string;
  baseLabel?: string;
  digest?: string;
  output?: string;
  truncated?: boolean;
  error?: string;
}

export interface LiveBody {
  active: boolean;
  servedAt: string;
  output: LiveOutputShape | null;
  diff: LiveDiffShape | null;
}

function age(fromIso: string, nowMs: number): string {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return "";
  const s = Math.max(0, Math.round((nowMs - from) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ${s % 60}s ago`;
}

/** The page's poll cadence while a run is active. Matches LIVE_POLL_MS in src/live-view.ts. */
export const LIVE_POLL_MS = 2_000;

const short = (sha: string | undefined): string => (sha === undefined ? "?" : sha.slice(0, 10));

export interface TerminalView {
  header: string;
  status: string;
  text: string;
  note?: string;
}

export function terminalView(output: LiveOutputShape | null, nowMs: number): TerminalView | null {
  if (output === null) return null;
  const turn = output.turn !== undefined ? `turn ${output.turn} · ` : "";
  const status = output.running
    ? `${turn}running · output ${age(output.lastChunkAt, nowMs)}`
    : `${turn}exit ${output.exitCode ?? "?"}${output.timedOut ? " (timed out)" : ""} · ended ${age(output.at, nowMs)}`;
  return {
    header: `$ ${output.command}`,
    status,
    text: output.output === "" ? (output.running ? "(no output yet)" : "(no output)") : output.output,
    ...(output.truncated ? { note: "Only the tail is kept." } : {}),
  };
}

export type DiffTone = "add" | "del" | "hunk" | "file" | "";

export interface DiffView {
  instant: string;
  lines: { text: string; tone: DiffTone }[];
  empty: boolean;
  partial: boolean;
  error?: string;
}

export function diffLineTone(line: string): DiffTone {
  if (line.startsWith("diff --git") || line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("index ")) return "file";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

/**
 * The instant line says exactly which tree the diff describes: the sandbox
 * clock at the moment the single diff command ran, HEAD at that moment, the
 * base it is against, and a digest of the bytes.
 */
export function diffView(diff: LiveDiffShape | null): DiffView | null {
  if (diff === null) return null;
  const when = diff.sandboxAt ?? diff.at;
  const parts = [`Snapshot ${when}${diff.sandboxAt !== undefined ? " (sandbox clock)" : ""}`];
  if (diff.head !== undefined) parts.push(`HEAD ${short(diff.head)}`);
  if (diff.base !== undefined) parts.push(`vs ${short(diff.base)}${diff.baseLabel ? ` (${diff.baseLabel})` : ""}`);
  else if (diff.baseLabel) parts.push(`vs ${diff.baseLabel}`);
  if (diff.digest !== undefined) parts.push(`sha256:${diff.digest}`);
  const output = diff.output ?? "";
  return {
    instant: parts.join(" · "),
    lines: output === "" ? [] : output.replace(/\n$/, "").split("\n").map((text) => ({ text, tone: diffLineTone(text) })),
    empty: diff.error === undefined && output === "",
    partial: diff.truncated === true,
    ...(diff.error !== undefined ? { error: diff.error } : {}),
  };
}
