import { useEffect, useRef } from "preact/hooks";
import { RichText } from "./rich-text.js";
import { safeLink, splitDiff } from "../lib/workspace.js";
import type { Message, DiffSnapshot, Evidence, PreviewPanel } from "../lib/workspace.js";
export function Conversation({ messages, expanded = false }: { messages: Message[]; expanded?: boolean }) {
  const root = useRef<HTMLElement>(null);
  const previousHeight = useRef<number | null>(null);
  useEffect(() => {
    const scroller = root.current?.parentElement;
    if (!scroller?.classList.contains("conversation-scroll")) return;
    if (previousHeight.current === null || scroller.scrollTop + scroller.clientHeight >= previousHeight.current - 60) scroller.scrollTop = scroller.scrollHeight;
    previousHeight.current = scroller.scrollHeight;
  }, [messages.length]);
  const earlier = !expanded && messages.length > 8 ? messages.slice(0, -6) : [];
  const recent = earlier.length ? messages.slice(-6) : messages;
  return (
    <section ref={root} aria-label="Conversation" class="conversation">
      {earlier.length > 0 && <details class="disclosure"><summary>{earlier.length} earlier messages</summary><Conversation messages={earlier} expanded /></details>}
      {recent.map((m, i) => (
        <article class="message" key={i}>
          <div class="kind">
            {m.role}
            <time dateTime={m.at}>{m.at.replace("T", " ").slice(0, 16)}</time>
          </div>
          <RichText text={m.text} />
        </article>
      ))}
      {messages.length === 0 && <p class="empty">No messages recorded yet.</p>}
    </section>
  );
}
export function Changes({
  snapshots,
  pr,
  sha,
}: {
  snapshots: DiffSnapshot[];
  pr?: string;
  sha?: string;
}) {
  return (
    <section>
      <h2 class="section">Changes</h2>
      {sha && (
        <p class="meta">
          Recorded revision <code>{sha}</code>
        </p>
      )}
      {safeLink(pr) && (
        <p>
          <a href={safeLink(pr)} target="_blank" rel="noreferrer">
            Review the current pull request →
          </a>
        </p>
      )}
      <p class="meta">
        Snapshots below are captured during execution. Each names its recorded
        step; the pull request is the current published change.
      </p>
      {snapshots.length === 0 ? (
        <p class="empty">
          No diff snapshot was recorded for this run. A published pull request
          may still contain changes.
        </p>
      ) : (
        snapshots.map((s, i) => (
          <details class="diff-snapshot" open={i === 0} key={i}>
            <summary>
              {s.name} · {s.at.replace("T", " ").slice(0, 16)}
              {s.truncated ? " · partial snapshot" : ""}
            </summary>
            {splitDiff(s.diff).map((f, j) => (
              <details class="diff-file" open={j === 0} key={j}>
                <summary>{f.file}</summary>
                <pre class="diff-code">
                  {f.lines.map((line, k) => (
                    <span
                      key={k}
                      class={
                        line.startsWith("+")
                          ? "diff-add"
                          : line.startsWith("-")
                            ? "diff-remove"
                            : line.startsWith("@@")
                              ? "diff-hunk"
                              : ""
                      }
                    >
                      {line}
                      {"\n"}
                    </span>
                  ))}
                </pre>
              </details>
            ))}
          </details>
        ))
      )}
    </section>
  );
}
const stamp = (at: string) => at.replace("T", " ").slice(0, 16) + " UTC";

/**
 * The run's preview (DELEGATED_DECISIONS_2026-09-23 §10): a frame of the
 * preview's OWN hostname plus a link to open it in a tab. Never a dashboard
 * path — agent-written code must not run on this origin.
 */
export function PreviewPanelView({ panel }: { panel: PreviewPanel }) {
  return (
    <section class="preview-panel" aria-labelledby="preview-panel-heading">
      <h2 class="section" id="preview-panel-heading">Preview</h2>
      {panel.state === "none" && (
        <p class="meta">
          No preview was declared for this run. Declare a preview app on the{" "}
          <a href="/projects">project</a> to get one.
        </p>
      )}
      {panel.state === "deploying" && (
        <p class="meta" role="status">
          Not deployed yet. The preview deploys after the change is pushed;
          refresh this page to check.
        </p>
      )}
      {panel.state === "not-deployed" && <p class="meta">No preview: {panel.reason}</p>}
      {panel.state === "failed" && <p class="notice bad">Preview deploy failed: {panel.reason}</p>}
      {panel.state === "expired" && (
        <p class="meta">
          Expired {stamp(panel.expiresAt)}. Expired previews are removed, so{" "}
          <code>{panel.url}</code> no longer serves this change.
        </p>
      )}
      {panel.state === "removed" && (
        <p class="meta">
          Removed: {panel.reason} <code>{panel.url}</code> no longer serves this change.
        </p>
      )}
      {panel.state === "deployed" && (
        <>
          <div class="preview-bar">
            <a class="button" href={panel.url} target="_blank" rel="noopener noreferrer">
              Open preview in a new tab ↗
            </a>
            <span class="meta">
              {panel.expiresAt !== undefined ? `Expires ${stamp(panel.expiresAt)}` : "Expiry not recorded"}
            </span>
          </div>
          <p class="meta">
            Sign-in and OAuth flows need the full page: use the tab. If the
            frame stays blank, the app may refuse to be framed or this browser
            cannot reach the preview's network.
          </p>
          {panel.blocked !== undefined ? (
            <p class="notice warn">{panel.blocked}</p>
          ) : (
            <iframe
              class="preview-frame"
              src={panel.url}
              title="Live preview of this run's change"
              loading="lazy"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            />
          )}
        </>
      )}
    </section>
  );
}

export function Verification({ data, preview }: { data: Evidence; preview?: PreviewPanel }) {
  return (
    <section>
      <h2 class="section">Verification</h2>
      <p class="meta">
        Recorded checks for this run. “Not recorded” means no evidence is
        available; it does not mean passed.
      </p>
      {preview !== undefined && <PreviewPanelView panel={preview} />}
      <div class="evidence-actions">
        {preview === undefined && data.preview && (
          <a
            class="button"
            href={data.preview}
            target="_blank"
            rel="noreferrer"
          >
            Open preview ↗
          </a>
        )}
        {data.pr && (
          <a class="button" href={data.pr} target="_blank" rel="noreferrer">
            Open pull request ↗
          </a>
        )}
      </div>
      <div class="check-list">
        {data.checks.filter(c => c.state !== "not recorded").map((c) => (
          <article class="check-row" key={c.name}>
            <b>{c.name}</b>
            <span
              class={
                ["passed", "healthy", "deployed", "merged"].includes(c.state)
                  ? "good"
                  : ["failed", "errored", "worse", "blocked"].includes(c.state)
                    ? "bad"
                    : "meta"
              }
            >
              {c.state}
            </span>
            <div>
              {c.detail}
              {c.output && (
                <details>
                  <summary>View output</summary>
                  <pre>{c.output}</pre>
                </details>
              )}
            </div>
          </article>
        ))}
      </div>
      {data.checks.some(c => c.state === "not recorded") && <details class="disclosure"><summary>{data.checks.filter(c => c.state === "not recorded").length} checks not recorded</summary><p class="meta">{data.checks.filter(c => c.state === "not recorded").map(c=>c.name).join(' · ')}</p><a href="/setup">Configure project verification</a></details>}
      {data.unattached.length > 0 && (
        <p class="notice">
          {data.unattached.length} captured file(s) have no downloadable
          attachment. This forge may not support uploads, or an upload exceeded
          its size limit or failed. The recorded check result remains visible.
        </p>
      )}
      {data.videos.length > 0 && (
        <>
          <h2 class="section">Browser recordings</h2>
          {data.videos.map((v) => (
            <figure class="browser-recording">
              <video controls preload="none" src={v.href} aria-label={v.name} />
              <figcaption>
                <a href={v.href} target="_blank" rel="noreferrer">
                  {v.name}
                </a>
              </figcaption>
            </figure>
          ))}
        </>
      )}
      {data.images.length > 0 && (
        <>
          <h2 class="section">Browser evidence</h2>
          <div class="evidence-gallery">
            {data.images.map((im, i) => (
              <figure key={i}>
                <a href={im.href} target="_blank" rel="noreferrer">
                  <img
                    src={im.href}
                    alt={im.name}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                  />
                </a>
                <figcaption>{im.name}</figcaption>
              </figure>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
