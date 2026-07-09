/** CLI argument parsing, separated from cli.ts so it's importable in tests. */
export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const boolFlags = new Set(["durable", "yes", "json", "headless", "handoff", "plan"]);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (boolFlags.has(name)) flags[name] = true;
      else flags[name] = argv[++i] ?? "";
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}
