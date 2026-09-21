import type { ComponentChildren } from "preact";
import { safeLink } from "../lib/workspace.js";
/** A deliberately small Markdown renderer. Text stays escaped; raw HTML and images never execute. */
function inline(text: string): ComponentChildren[] {
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g)
    .map((s, i) => {
      if (s.startsWith("`") && s.endsWith("`"))
        return <code key={i}>{s.slice(1, -1)}</code>;
      if (s.startsWith("**") && s.endsWith("**"))
        return <strong key={i}>{s.slice(2, -2)}</strong>;
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(s);
      if (link && safeLink(link[2]))
        return (
          <a key={i} href={safeLink(link[2])} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      return s;
    });
}
export function RichText({ text }: { text: string }) {
  const marker = /(?:^|\n)FINDINGS_JSON:\s*(\[[\s\S]*\])\s*$/.exec(text);
  if (marker) {
    try {
      const findings = JSON.parse(marker[1]!);
      if (Array.isArray(findings)) return <><RichText text={text.slice(0, marker.index)} /><details class="disclosure"><summary>Structured findings ({findings.length})</summary><pre>{marker[1]}</pre></details></>;
    } catch {}
  }
  const lines = text.split("\n"),
    blocks: ComponentChildren[] = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, "").trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!))
        code.push(lines[i++]!);
      i++;
      if (language === "finish" && blocks.length > 0) {
        blocks.push(<details class="disclosure"><summary>Completion details</summary><pre><code>{code.join("\n")}</code></pre></details>);
        continue;
      }
      blocks.push(
        <div class="code-block">
          <span class="meta">{language || "Code"}</span>
          <pre>
            <code>{code.join("\n")}</code>
          </pre>
        </div>,
      );
      continue;
    }
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push(<h3>{inline(heading[1]!)}</h3>);
      i++;
      continue;
    }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const items: ComponentChildren[] = [],
        ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]!))
        items.push(
          <li>{inline(lines[i++]!.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>,
        );
      blocks.push(ordered ? <ol>{items}</ol> : <ul>{items}</ul>);
      continue;
    }
    const paragraph = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(?:```|#{1,6}\s|[-*]\s|\d+\.\s)/.test(lines[i]!)
    )
      paragraph.push(lines[i++]!);
    blocks.push(<p>{inline(paragraph.join("\n"))}</p>);
  }
  return <div class="rich-text">{blocks}</div>;
}
