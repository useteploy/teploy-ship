# Tool-vocabulary addendum — browser perception input (2026-10-14)

Research addendum to `docs/PERCEPTION_INPUT_S12_S13_2026-10-14.md` (D2, the
`look` action). It sharpens the planned vocabulary and the element-referencing
scheme before the slice is cut. No code in this repo was changed; every claim
below is from primary sources read on 2026-10-14 (URLs in §7). Claims that
come from reading source code are marked **[code]**; claims inferred rather
than observed live are marked **[inferred]**.

## 1. The observed 2026 verb inventory

Four references, surveyed 2026-10-14.

### 1.1 Playwright MCP (`microsoft/playwright-mcp`; tool source now lives in the Playwright monorepo, `packages/playwright-core/src/tools/backend/`)

Core capability (always on). Names and load-bearing params exactly as
documented/generated from source:

| Verb | Key params | Meaning |
|---|---|---|
| `browser_navigate` | `url` | Go to URL |
| `browser_navigate_back` | — | History back |
| `browser_snapshot` | `target?`, `filename?`, `depth?`, `boxes?` | A11y snapshot; "this is better than screenshot". `target` snapshots a **subtree**; `filename` writes the snapshot to a file instead of the response; `depth` caps tree depth; `boxes` adds viewport-relative bounding boxes |
| `browser_find` | `text?` \| `regex?`, `filename?` | Search the snapshot, return matching nodes with context snippets **and their refs** — "cheaper than capturing the whole snapshot when you only need to locate an element and its ref" |
| `browser_click` | `element?`, `target`, `doubleClick?`, `button?`, `modifiers?` | Click |
| `browser_hover` | `element?`, `target` | Hover |
| `browser_drag` | `startTarget`/`endTarget` (+ descriptions) | Drag between elements |
| `browser_drop` | `target`, `paths?` \| `data?` | Drop files / MIME data |
| `browser_type` | `target`, `text`, `submit?`, `slowly?` | Type into element |
| `browser_fill_form` | `fields[]` | Fill many fields at once |
| `browser_select_option` | `target`, `values[]` | Dropdown |
| `browser_press_key` | `key` | Keyboard |
| `browser_take_screenshot` | `target?`, `type?`, `filename?`, `fullPage?`, `scale` | Pixels; explicitly: "You can't perform actions based on the screenshot, use browser_snapshot for actions" |
| `browser_tabs` | `action`: list/new/close/select, `index?`, `url?` | One multiplexed tab tool |
| `browser_handle_dialog` | `accept`, `promptText?` | Dialogs |
| `browser_file_upload` | `paths?` | File chooser |
| `browser_console_messages` | `level`, `all?`, `filename?` | Console |
| `browser_network_requests` / `browser_network_request` | `filter?` / `index` | Request list / one request in full |
| `browser_evaluate` | `function`, `target?`, `element?`, `filename?` | JS in page (or on element) |
| `browser_run_code_unsafe` | `code`, `filename?` | Playwright snippet in the server process — "RCE-equivalent", the marked escape hatch |
| `browser_wait_for` | `time?` \| `text?` \| `textGone?` | Wait (≤30 s) |
| `browser_close`, `browser_resize`, `browser_emulate_media` | — | Lifecycle/viewport/media |

Opt-in capabilities (`--caps=…`): network (route/unroute/offline), storage
(cookies/localStorage/sessionStorage/storage-state), testing
(`browser_verify_*`, `browser_generate_locator`), devtools (tracing, video,
highlight/annotate, recording), pdf, vision (coordinate mouse: `*_xy`), config.

### 1.2 Chrome DevTools MCP (`ChromeDevTools/chrome-devtools-mcp`, ~59 tools)

Input: `click drag fill fill_form handle_dialog hover press_key type_text
upload_file click_at` (coordinate click behind `--experimentalVision`).
Navigation: `close_page list_pages navigate_page new_page select_page
wait_for`. Emulation: `emulate resize_page`. Debugging: `evaluate_script
get_console_message get_css_styles lighthouse_audit list_console_messages
screencast_start screencast_stop take_screenshot take_snapshot`. Plus
performance, network, 14 heap-snapshot tools, extensions, WebMCP, PWA.

The two that matter for text-first perception:

- `take_snapshot` — "text snapshot … based on the a11y tree … lists page
  elements along with a unique identifier (**uid**). **Always use the latest
  snapshot. Prefer taking a snapshot over taking a screenshot.**" Params:
  `pageId`, `filePath?` (save instead of attach), `verbose?`.
- `evaluate_script` — `waitForStableDom: true` **by default**.
- Input tools share `uid` + `pageId` params and an opt-in `includeSnapshot`
  on the **response** side (snapshot rides along with the action result).

### 1.3 browser-use V4 (`browser-use/browser-use`, MIT)

Default registry (`browser_use/tools/service.py`), by action name:
`search` (engine query, new tab), `navigate`, `go_back`, `wait` (seconds,
default 3), `click`, `input`, `upload_file`, `switch`/`close` (tabs),
`extract`, `search_page`, `find_elements`, `scroll`, `send_keys`,
`find_text`, `screenshot`, `save_as_pdf`, `dropdown_options`,
`select_dropdown`, `write_file`, `replace_file`, `read_file`, `evaluate`,
`done` (structured finish).

Two design points worth stealing:

- **Element reference is an integer `index`** into the serialized DOM state
  (`ClickElementAction.index`, `ge=1`, "Element index from browser_state"),
  with optional viewport `coordinate_x/y` as the vision fallback. CDP
  `backendNodeId` handles the actual resolution. **[code]**
- **`extract` is query-driven pagination over page-as-markdown**: the page is
  serialized to markdown, and `start_from_char` pages through it; an optional
  JSON Schema returns validated structured output. Text-first with explicit
  token controls, not a dump. **[code]**

### 1.4 Anthropic's browser toolset (31 actions; seen via browser-use's implementation, `browser_use/integrations/anthropic/browser_use.py`)

`navigate screenshot zoom left_click right_click middle_click double_click
triple_click hover mouse_move left_mouse_down left_mouse_up left_click_drag
scroll scroll_to type key hold_key form_input read_page find get_page_text
wait file_upload read_console read_network javascript_exec new_tab list_tabs
switch_tab close_tab`.

Note the text-first verbs sitting **beside** the pixel verb, not under it:
`read_page` (a11y tree read), `find`, `get_page_text` — screenshot is one
tool among thirty-one, not the substrate. **[code]**

## 2. Convergent mechanics (what all four do)

1. **Snapshot-first perception.** The a11y tree / DOM text is *the* action
   surface; screenshots are for humans and layout questions. Playwright MCP
   and Chrome DevTools MCP both say it in tool descriptions verbatim.
2. **Ephemeral per-snapshot element refs.** Refs are minted when a snapshot
   is rendered and die with it; every action refreshes/returns a snapshot;
   a stale ref fails loudly (§4).
3. **Ref + human description pairing.** `target`/`uid`/`index` names the
   node; a human-readable description (`element` in Playwright MCP) rides
   along "to obtain permission to interact with the element" — audit and
   codegen fodder, not resolution.
4. **Settle-after-action instead of fixed sleeps.** Playwright MCP's
   `waitForCompletion`: run action → wait settle (default 500 ms) → if any
   navigation request fired, wait for `load` (≤10 s) → drain in-flight
   document/stylesheet/script/xhr/fetch responses. **[code]** CDP MCP:
   `waitForStableDom` default true. browser-use: `wait` default 3 s.
5. **Token controls beyond truncation.** Subtree snapshots
   (`browser_snapshot{target,depth}`), snippet search over the snapshot
   (`browser_find`), file-output instead of context (`filename` /
   `filePath`), markdown pagination (`extract{start_from_char}`).
6. **One multiplexed tab surface** (`browser_tabs` actions / `pageId`
   param), not per-tab sessions.
7. **Marked escape hatches.** `browser_run_code_unsafe` names itself
   RCE-equivalent rather than pretending to be sandboxed.

## 3. Recommended minimal verb set for ship's CodeAct extension

**Recommendation: exactly one new verb — `look`. No click/type/wait
companions.**

The decisive input is Playwright MCP's own README (2026-10-14): for coding
agents it now points to **CLI+SKILLS instead of MCP**, because CLI calls
"avoid loading large tool schemas and verbose accessibility trees into the
model context" — i.e. even the a11y-tree-first vendor concedes that an agent
which already has a shell and Playwright should drive the browser with code,
reserving structured tools for the observation itself. Ship's CodeAct *is*
that shape: `bash`/`python` with a pinned Playwright already run in-sandbox
(the `.ship/flow.mjs` precedent), one action per turn, recorded-result
replay.

So the loop needs a verb only where the **observation entering model context
must be owned by the loop** — redaction, truncation, injection fencing,
budgets, replay. That is `look`:

```
look  — observe the run's browser page as text (a11y tree with refs).
        modes: text (default) | image (gated per D4 owner gate, default off)
        selectors: find=<text or regex>   → browser_find-style snippet result
                   ref=<f?e ref>          → subtree under that element
        depth cap; snapshot text always lands as an observation through
        scrub()/truncate() exactly like a bash observation.
```

Justification per candidate verb:

- `look` — yes. Perception is the loop's responsibility; it cannot be
  delegated to agent code because the output is what the model sees next.
- `click`/`type`/`hover`/… — no. Agent-authored Playwright code does this
  with better actionability, and the references' own trajectory (code over
  tools for coding agents) says duplicating the vocabulary buys prompt
  weight, not capability.
- `wait` — no. Settle belongs *inside* the driver (adopt the §2.4 recipe);
  deliberate long waits belong in agent code. If a measured need appears,
  add `look --settle` later, not a new verb.
- tab management — no. Default one tab per run; multi-tab is agent code
  (`context.pages()`) until a journey proves otherwise.
- screenshot — not a verb: a **mode** of `look`, gated by the D4 owner
  decision, off by default.

This is smaller than the plan's D2 wording implies ("look + browser-step cap
+ image budget") — those caps stay, but they parameterize one verb.

## 4. Element-referencing scheme for a11y snapshots

Adopt Playwright MCP's scheme; it is the most specified and it solves
iframes in the grammar itself:

1. **Ref grammar** `(f<frame>)?e<n>` — e.g. `e12`, `f2e3` for an element
   inside an iframe. Verified in source: `targetLocators()` validates
   `target` against `/^(f\d+)?e\d+$/` before treating it as a ref. **[code]**
2. **Minted per snapshot render.** Refs come from the a11y snapshot itself
   (`page.ariaSnapshot({ mode: 'ai', … })` in the current source) and are
   meaningful only until the page changes; every Playwright-MCP action
   response re-includes a fresh snapshot (`response.setIncludeSnapshot()`),
   so the model always holds current refs. **[code]**
3. **Loud stale-ref failure, no fuzzy matching.** Resolution goes through
   `page.getByRef(target)` and on failure returns: *"Ref e12 not found in
   the current page snapshot. Try capturing new snapshot."* Ship's `look`
   should copy this error shape verbatim-in-spirit. **[code]**
4. **Selectors as a first-class alternative.** A `target` that doesn't match
   the ref grammar is parsed as a selector (CSS/testid) and must match
   exactly one element. **[code]**
5. **Description rides along.** Ship-level acts that reference an element
   should carry the human-readable description next to the ref (Playwright
   MCP's `element` param, attached via `locator.describe()`) — it is what an
   auditor reads and what permission prompts show. **[code]**
6. **Follow-up actions in ship's shape**: since actions are code, the agent
   resolves refs in its own Playwright script via `getByRef`-equivalent
   against the still-live page; ship's driver exposes ref resolution over
   CDP so the same refs the loop observed are usable by the code the agent
   writes. `[inferred — the seam's exact API is a slice decision]`
7. **Snapshot text pagination**: ship's observation truncation
   (`truncate()`, default 8000 chars) would otherwise cut the tree at an
   arbitrary point and can hide the very element the agent needs; the 2026
   answer is `look find=…` (snippet search returning refs) and `look ref=…`
   (subtree) rather than a bigger truncate budget. **[code for the
   references' behavior; ship-side is proposal]**

## 5. Explicit deltas vs the merged plan doc

- **D2 confirmed, and cut further.** Text-first is the convention everywhere
  (§2.1); no contradiction found. New input the plan lacks: Playwright MCP's
  own CLI-over-MCP guidance for coding agents → ship should ship **one**
  verb, not "look plus companions" (§3).
- **Element referencing was unspecified** in the plan ("accessibility tree /
  DOM text as the primary observation" says nothing about how a follow-up
  names an element). §4 fills this: `(f\d+)?e\d+` grammar, per-snapshot
  minting, loud stale-ref error, selector alternative.
- **Token control must be structural, not `truncate()`.** The plan's "image
  history pruned to the last N observations" is necessary but the text side
  also needs `find`/subtree modes from day one (§4.7) — none of the
  references rely on plain truncation for snapshot text.
- **Settle semantics for the driver**: replace any fixed-sleep idea with the
  waitForCompletion recipe (settle 500 ms → nav-load wait → drain in-flight
  doc/css/js/xhr/fetch) **[code]**. The plan is silent on this.
- **Tabs**: converge on one-tab-per-run default with multi-tab deferred to
  agent code; the plan doesn't mention tabs at all.
- **Screenshot gating (D4) reinforced**: all references keep screenshot as a
  separate, non-actionable read ("You can't perform actions based on the
  screenshot"). No delta, one more citation.
- **The proxy question (D3) is untouched by this research** — none of these
  sources speak to authenticated-egress Chromium; the live 407 proof remains
  outstanding, exactly as §7.1 of the plan sequences it.

## 6. What was NOT verified

- **Nothing was run live.** No browser, no `npx @playwright/mcp`, no docker
  (see the receipt). All findings are from reading primary-source code and
  docs fetched 2026-10-14. Runtime behaviors (ref minting order, error text
  at runtime, iframe rendering in a real nested-frame page) are **inferred**
  from source, not observed.
- Chrome DevTools MCP `--slim` tool list (`docs/slim-tool-reference.md`) not
  fetched; the full reference was used.
- Playwright's `ariaSnapshot({mode:'ai'})` internals (where the `e<n>`
  counter is assigned) not read — it lives in `@isomorphic/ariaSnapshot`
  inside the monorepo; the minting claim rests on usage + rendered examples.
- browser-use's serialized-DOM *rendering* (the exact `[index=N]` text
  format) not read line-by-line; the index scheme is confirmed from the
  action parameter models.
- Anthropic's native browser-toolset documentation was not fetched; §1.4 is
  browser-use's implementation of it (count and names from source).
- Whether `page.getByRef()` is exposed in the pinned Playwright 1.63.0 that
  the sandbox image bakes (vs. only in-current main) — must be checked
  before the slice assumes it.

## 7. Sources (all fetched/read 2026-10-14)

- Playwright MCP README (tool list + params + CLI-vs-MCP note):
  https://github.com/microsoft/playwright-mcp/blob/main/README.md
- Playwright MCP docs (core/caps tables, snapshot example):
  https://playwright.dev/mcp/introduction · https://playwright.dev/mcp/capabilities
- Tool source (monorepo): `packages/playwright-core/src/tools/backend/` —
  `snapshot.ts` (schemas), `tab.ts` (`targetLocators`, `ariaSnapshot` call),
  `utils.ts` (`waitForCompletion`):
  https://github.com/microsoft/playwright/tree/main/packages/playwright-core/src/tools
- Integration test showing `element`+`target` and `[ref=e2]`:
  https://github.com/microsoft/playwright-mcp/blob/main/tests/click.spec.ts
- Chrome DevTools MCP tool reference:
  https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md
- browser-use V4 action registry + views:
  https://github.com/browser-use/browser-use/blob/main/browser_use/tools/service.py ·
  …/browser_use/tools/views.py · …/browser_use/actor/element.py
- browser-use's implementation of Anthropic's 31-action browser toolset:
  https://github.com/browser-use/browser-use/blob/main/browser_use/integrations/anthropic/browser_use.py
- browser-use README (product map, MIT, 31-action claim):
  https://github.com/browser-use/browser-use/blob/main/README.md
