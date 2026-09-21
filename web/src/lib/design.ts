/** Layout refinements within Ship's existing Teploy visual language.
 * Palette, monospace typography, top navigation and shared controls belong
 * to _layout.tsx. Keep additions on those tokens, rather than reskinning it.
 */
export const DESIGN_CSS = `
:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
input, select, textarea { min-width: 0; max-width: 100%; }
textarea { resize: vertical; }
input[type=search] { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; font: inherit; }
button:disabled { opacity: .5; cursor: not-allowed; }
.button { display: inline-flex; align-items: center; justify-content: center; padding: 8px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel); color: var(--text); font-size: 12px; white-space: nowrap; }
.button:hover { border-color: var(--dim); text-decoration: none; }
button.primary, .button.primary { color: var(--green); border-color: var(--green); }
.skip-link { position: fixed; top: -60px; left: 12px; z-index: 100; padding: 10px; background: var(--panel); }
.skip-link:focus { top: 8px; }
h1.page, .meta, code, .config-value { overflow-wrap: anywhere; }
.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
.page-heading .meta { margin-bottom: 0; }
.eyebrow { font-size: 12px; color: var(--dim); margin-bottom: 10px; }
.row-actions { flex-wrap: wrap; }
.table-wrap { max-width: 100%; margin: 14px 0; }
table.runs td { padding-top: 10px; padding-bottom: 10px; }
.empty h3 { font-size: 14px; font-weight: 500; color: var(--text); margin: 0 0 8px; }
.empty p { margin: 0; }
.summary-grid { display: flex; gap: 20px; flex-wrap: wrap; padding: 10px 0 16px; border-bottom: 1px solid var(--border); margin-bottom: 18px; }
.summary-card { font-size: 12px; color: var(--dim); }
.summary-card strong { color: var(--text); margin-right: 8px; font-weight: 500; }
.composer { margin: 18px 0 24px; }
.composer > label { display: block; font-size: 13px; margin-bottom: 8px; }
.composer textarea { width: 100%; padding: 10px 12px; line-height: 1.6; }
.composer-footer { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin-top: 12px; }
.composer-footer .field { flex: 1; min-width: 220px; }
.field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--dim); }
.field input, .field select { width: 100%; }
.check-field { display: flex; gap: 6px; align-items: center; font-size: 12px; min-height: 36px; }
.settings-layout { display: block; }
.settings-nav { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0 24px; }
.settings-nav a { padding: 4px 11px; border-radius: 12px; border: 1px solid var(--border); color: var(--dim); font-size: 12px; }
.settings-nav a:hover, .settings-nav a.active { color: var(--text); border-color: var(--dim); text-decoration: none; }
.settings-content { min-width: 0; }
.settings-content > h2 { font-size: 14px; font-weight: 500; text-transform: uppercase; letter-spacing: .05em; color: var(--dim); margin: 20px 0 10px; }
.settings-cards { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 0 24px; margin: 18px 0; }
.settings-cards .card { margin: 0; padding: 16px 0; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; }
.settings-cards h3 { font-size: 13px; font-weight: 500; margin: 0 0 8px; }
.settings-cards p { font-size: 12px; color: var(--dim); margin: 0 0 8px; }
.config-section { margin: 22px 0; }
.config-section h3, .config-section > summary { font-size: 13px; font-weight: 500; color: var(--dim); margin: 0; padding: 10px 0; border-bottom: 1px solid var(--border); }
.config-section > summary { cursor: pointer; }
.config-row { display: grid; grid-template-columns: minmax(140px,1fr) minmax(0,2fr); gap: 20px; padding: 12px 10px; border-bottom: 1px solid var(--border); }
.config-label { font-size: 12px; color: var(--dim); overflow-wrap: anywhere; }
.config-key { display: block; font: inherit; font-size: 10px; margin-top: 4px; }
.config-value { font-size: 13px; }
.config-value .meta { margin: 8px 0 0; }
.config-value details { margin-top: 6px; }
.config-value summary { cursor: pointer; color: var(--dim); font-size: 12px; }
.team-form { display: grid; grid-template-columns: 1fr 1fr 140px auto; align-items: end; gap: 12px; margin: 18px 0; }
.disclosure { margin: 16px 0; }
.disclosure > summary { cursor: pointer; color: var(--dim); font-size: 12px; }
.disclosure[open] > summary { margin-bottom: 12px; }
.project-form, .form-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; align-items: start; }
.project-form { margin: 16px 0; }
.project-form .meta { margin: 0; }
.form-section { grid-column: 1/-1; min-width: 0; border-top: 1px solid var(--border); padding-top: 14px; }
.form-section summary { cursor: pointer; font-size: 13px; margin-bottom: 14px; }
.run-toolbar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; justify-content: space-between; margin: 16px 0; }
.run-toolbar input { min-width: 230px; }
.run-title { display: block; }
.run-id { display: block; font-size: 11px; color: var(--dim); margin-top: 5px; }
.run-task { min-width: 250px; max-width: 560px; }
.run-updated { white-space: nowrap; }

.conversation { margin: 16px 0 24px; }
.message { border-bottom: 1px solid var(--border); padding: 16px 0; }
.message .kind { display: flex; justify-content: space-between; gap: 12px; color: var(--dim); font-size: 12px; margin-bottom: 8px; }
.message time { font-size: 11px; }
.message-text { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.message-composer { border-top: 1px solid var(--border); padding-top: 18px; margin-top: 24px; }
.message-composer textarea { padding: 10px; font: inherit; width: 100%; }
.message-composer button { margin-top: 10px; }
.diff-snapshot { margin: 18px 0; }
.diff-snapshot > summary, .diff-file > summary { cursor: pointer; overflow-wrap: anywhere; padding: 10px 0; }
.diff-file { border-top: 1px solid var(--border); }
.diff-code { overflow: auto; max-height: 600px; font-size: 12px; line-height: 1.6; padding: 12px; background: var(--panel); }
.diff-code span { white-space: pre; }
.diff-add { color: var(--green); background: #3fb9500d; }
.diff-remove { color: var(--red); background: #f851490d; }
.diff-hunk { color: var(--blue); }
.evidence-actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0; }
.check-row { display: grid; grid-template-columns: 150px 120px minmax(0,1fr); gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.check-row b { font-weight: 500; }
.check-row > div { overflow-wrap: anywhere; }
.check-row pre { max-height: 350px; overflow: auto; white-space: pre-wrap; }
.browser-recording { margin: 16px 0; }
.browser-recording video { width: 100%; max-height: 550px; background: var(--panel); }
.evidence-gallery { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; }
.evidence-gallery figure { margin: 0; }
.evidence-gallery img { max-width: 100%; border: 1px solid var(--border); }
.evidence-gallery figcaption { color: var(--dim); font-size: 12px; margin: 8px 0; }
.workflow-row { display: flex; justify-content: space-between; gap: 20px; padding: 20px 0; border-bottom: 1px solid var(--border); }
.workflow-row h2, .setup-step h2 { font-size: 14px; font-weight: 500; margin: 0 0 8px; }
.workflow-row .row-actions { align-content: center; flex-shrink: 0; }
.setup-list { padding: 0; list-style: none; }
.setup-step { padding: 20px 0; border-bottom: 1px solid var(--border); }
.setup-step > div { display: flex; justify-content: space-between; gap: 20px; }
.setup-step p { color: var(--dim); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }

.rich-text { line-height: 1.75; overflow-wrap: anywhere; max-width: 85ch; }
.rich-text p { white-space: pre-wrap; margin: 0 0 12px; }
.rich-text h3 { font-size: 14px; margin: 20px 0 10px; }
.rich-text ul, .rich-text ol { padding-left: 24px; margin: 10px 0 16px; }
.rich-text li { margin: 5px 0; }
.rich-text code { background: var(--panel); padding: 2px 4px; }
.code-block { margin: 14px 0; min-width: 0; }
.code-block pre { overflow: auto; white-space: pre; padding: 12px; border: 1px solid var(--border); }
.run-review-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1.1fr); gap: 28px; align-items: start; }
.run-review-grid > *, .review-evidence { min-width: 0; }
.review-evidence { border-left: 1px solid var(--border); padding-left: 24px; }
.review-evidence .check-row { grid-template-columns: minmax(100px,1fr) minmax(80px,1fr); }
.review-evidence .check-row > div { grid-column: 1/-1; }
.forge-panel { border-bottom: 1px solid var(--border); padding: 12px 0 18px; }
.workspace-file { white-space: pre; overflow: auto; max-height: 65vh; padding: 16px; background: var(--panel); }
.message-composer { max-width: 85ch; padding: 18px 0; }
.message-composer > .field { margin-bottom: 14px; }
.setup-environment { border-top: 1px solid var(--border); margin-top: 24px; padding-top: 8px; }
@media (max-width: 1000px) { .run-review-grid { grid-template-columns: 1fr; } .review-evidence { border-left: 0; padding-left: 0; border-top: 1px solid var(--border); } }
@media (max-width: 720px) {
  .check-row { grid-template-columns: 1fr 1fr; }
  .check-row > div { grid-column: 1 / -1; }
  .evidence-gallery { grid-template-columns: 1fr; }
  .workflow-row { flex-direction: column; }

  .page-heading { gap: 12px; }
  .summary-grid { gap: 10px 18px; }
  .summary-card { font-size: 11px; }
  .composer-footer .field { flex-basis: 100%; min-width: 0; }
  .settings-cards, .project-form, .form-grid { grid-template-columns: 1fr; }
  .team-form { grid-template-columns: 1fr 1fr; }
  .config-row { grid-template-columns: 1fr; gap: 6px; padding: 12px 0; }
  .run-toolbar input { width: 100%; min-width: 0; }
}

.task-choices { border: 0; padding: 0; margin: 20px 0; display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
.task-choices legend { margin-bottom: 10px; }
.task-choice { display: flex; align-items: flex-start; gap: 9px; padding: 12px; border: 1px solid var(--border); border-radius: 5px; cursor: pointer; }
.task-choice.selected { border-color: var(--blue); background: var(--panel); }
.task-choice small { display: block; color: var(--dim); margin-top: 6px; line-height: 1.6; }
.task-choice input { margin-top: 3px; }
.task-status { border-left: 2px solid var(--blue); padding: 12px 16px; margin: 16px 0; background: var(--panel); }
.task-status p { margin: 8px 0; line-height: 1.6; }
.conversation-scroll { max-height: 58vh; overflow-y: auto; overscroll-behavior: contain; padding-right: 12px; scrollbar-gutter: stable; }
#reply { scroll-margin-top: 72px; }
@media(max-width:600px) { .task-choices { grid-template-columns: 1fr; } .conversation-scroll { max-height: 52vh; } }
.project-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr)); gap:16px; }
.project-cards h2 { font-size:15px; overflow-wrap:anywhere; }
`;
