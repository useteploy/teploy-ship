import { createInterface } from "node:readline";

import type { Usage } from "@neutron-build/ai";

import type { Action } from "./actions.js";
import type { AgentEvent } from "./agent.js";

// Hand-rolled ANSI (no deps). Disabled when not a TTY or NO_COLOR is set.
const useColor = process.stderr.isTTY === true && process.env.NO_COLOR === undefined;
const wrap = (code: string) => (s: string) => (useColor ? `[${code}m${s}[0m` : s);
export const dim = wrap("2");
export const bold = wrap("1");
export const cyan = wrap("36");
export const yellow = wrap("33");
export const green = wrap("32");
export const red = wrap("31");

/** Stream an agent event to stderr in a scannable, Claude-Code-like layout. */
export function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "thought": {
      // Show the reasoning prose dimmed; the action block itself is
      // rendered by the "action" event, so strip fenced blocks here.
      const prose = event.text.replace(/```[\s\S]*?```/g, "").trim();
      if (prose !== "") process.stderr.write(`\n${dim(prose)}\n`);
      break;
    }
    case "action":
      process.stderr.write(`${cyan("▸")} ${bold(event.text)}\n`);
      break;
    case "observation": {
      const lines = event.text.split("\n");
      const shown = lines.slice(0, 12);
      for (const line of shown) process.stderr.write(`  ${dim(line)}\n`);
      if (lines.length > shown.length) process.stderr.write(`  ${dim(`… ${lines.length - shown.length} more lines`)}\n`);
      break;
    }
    case "finish":
      process.stderr.write(`\n${green("✓")} ${event.text}\n`);
      break;
    case "error":
      process.stderr.write(`${red("✗")} ${event.text}\n`);
      break;
  }
}

/** Describe an action fully for an approval decision (whole code, not a one-liner). */
export function renderActionForApproval(action: Action): string {
  switch (action.kind) {
    case "bash":
      return `bash:\n${indent(action.code)}`;
    case "python":
      return `python:\n${indent(action.code)}`;
    case "edit":
      return `edit ${action.file}:\n${indent(`SEARCH:\n${action.search}\nREPLACE:\n${action.replace}`)}`;
    case "create":
      return `create ${action.file} (${action.content.length} chars)`;
    default:
      return action.kind;
  }
}

function indent(text: string): string {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/** y/N prompt on the controlling TTY. Only call when stdin is a TTY. */
export async function promptApproval(action: Action): Promise<boolean> {
  process.stderr.write(`\n${yellow("⚠ approval required")}\n${renderActionForApproval(action)}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(`${bold("Run this action? [y/N] ")}`, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

/** One-line cost/usage summary (cache-aware). */
export function renderUsage(usage: Usage): string {
  const parts = [`${usage.inputTokens} in`, `${usage.outputTokens} out`];
  if (usage.cacheReadTokens !== undefined) parts.push(`${usage.cacheReadTokens} cache-read`);
  if (usage.cacheWriteTokens !== undefined) parts.push(`${usage.cacheWriteTokens} cache-write`);
  return `tokens: ${parts.join(", ")} (total ${usage.totalTokens})`;
}
