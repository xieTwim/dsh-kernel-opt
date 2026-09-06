/** Panel-only styles. Host tokens supply surfaces and text in both themes. */
export const PANEL_CSS = `
.ko-panel {
  --ko-accent: light-dark(#425fdf, #9aadff);
  --ko-text: var(--dsw-alias-label-primary, #202734);
  --ko-muted: var(--dsw-alias-label-secondary, #5d6677);
  --ko-small: 14px;
  --ko-body: 16px;
  --ko-emphasis: 18px;
  --ko-section: 20px;
  --ko-line-small: 22px;
  --ko-line-body: 26px;
  --ko-border: var(--dsw-alias-border-l1, rgba(110,123,148,.18));
  --ko-surface: var(--dsw-alias-bg-layer-1, #fff);
  --ko-tint: color-mix(in srgb, var(--ko-accent) 4%, var(--ko-surface));
  container: kernel-panel / inline-size;
  width: 100%; max-width: 1320px; min-width: 0; margin: 0 auto;
  padding: 28px 32px 36px; box-sizing: border-box;
  display: flex; flex-direction: column; gap: 20px;
  font: 16px/1.6 system-ui, -apple-system, sans-serif; color: var(--ko-text);
}
.ko-panel > * { flex-shrink: 0; }
.ko-panel *, .ko-strip * { box-sizing: border-box; }
.ko-panel button, .ko-panel input, .ko-panel select { font-family: inherit; }
.ko-panel :is(button, input, select) { min-height: 38px; }
.ko-panel button { transition: background .15s, opacity .15s; }
.ko-panel button:hover { filter: brightness(.96); }
.ko-panel :is(button, input, select, summary, [role=button]):focus-visible {
  outline: 2px solid var(--ko-accent); outline-offset: 4px;
}
.ko-header { display: flex; align-items: center; gap: 12px; }
.ko-brand { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 11px; color: var(--ko-accent); background: var(--ko-tint); border: 1px solid var(--ko-border); }
.ko-panel:fullscreen { max-width: none; background: var(--ko-surface); overflow: auto; padding: 32px max(32px, calc((100vw - 1300px) / 2)); }
.ko-focus-button { display: flex; align-items: center; gap: 6px; padding: 0 10px; border: 1px solid var(--ko-border); border-radius: 7px; background: var(--ko-surface); color: var(--ko-muted); font-size: 14px; cursor: pointer; }
.ko-progress { appearance: none; border: 0; display: block; width: 100%; height: 3px; border-radius: 3px; overflow: hidden; background: color-mix(in srgb, #4d6bfe 10%, transparent); }
.ko-progress::-webkit-progress-bar { background: color-mix(in srgb, #4d6bfe 10%, transparent); }
.ko-progress::-webkit-progress-value { background: #4d6bfe; border-radius: 3px; }
.ko-progress::-moz-progress-bar { background: #4d6bfe; border-radius: 3px; }
.ko-header h1 { font-size: 24px; line-height: 1.3; letter-spacing: -.025em; margin: 0; font-weight: 650; }
.ko-header-sub { font-size: 14px; color: var(--ko-muted); letter-spacing: .035em; margin-top: 2px; }
.ko-state { display: inline-flex; align-items: center; gap: 7px; margin-left: auto; font-size: 14px; color: var(--ko-muted); white-space: nowrap; }
.ko-state i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.ko-state[data-live=true] { color: var(--ko-accent); }
.ko-rail { padding: 10px 14px; border: 1px solid var(--ko-border); border-radius: 12px; background: var(--ko-tint); display: flex; flex-direction: column; gap: 8px; }
.ko-overview { display: grid; grid-template-columns: 300px minmax(0, 1fr); border: 1px solid var(--ko-border); border-radius: 18px; overflow: hidden; background: var(--ko-surface); box-shadow: 0 8px 32px rgba(24,39,75,.035); }
.ko-hero { color: #eff4ff; padding: 28px 24px; background: radial-gradient(ellipse at 100% 0, #2c427c 0, transparent 65%), #172442; display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.ko-hero-label { color: #c6d4f2; font-size: 14px; display: flex; align-items: center; gap: 7px; }
.ko-hero-label i { width: 6px; height: 6px; border-radius: 50%; background: #8edfc3; }
.ko-hero-number { font-size: clamp(60px, 6.5cqi, 76px); line-height: 1.15; font-weight: 600; letter-spacing: -.055em; font-variant-numeric: tabular-nums; margin-top: 12px; white-space: nowrap; }
.ko-hero-number small { font-size: .5em; color: #a8bcf9; margin-left: 5px; font-weight: 400; }
.ko-hero-caption { font-size: 14px; color: #b7c6e5; margin-top: 5px; }
.ko-comparison { display: flex; flex-direction: column; gap: 12px; }
.ko-comparison-label { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 14px; color: #b7c6e5; margin-bottom: 5px; }
.ko-comparison-label strong { color: #e8efff; font-size: 20px; font-weight: 500; font-variant-numeric: tabular-nums; }
.ko-bar { height: 6px; background: #ffffff0e; border-radius: 4px; overflow: hidden; }
.ko-bar span { display: block; height: 100%; min-width: 2px; background: #6c82b0; border-radius: inherit; }
.ko-bar[data-result] span { background: #97b1ff; }
.ko-hero-footer { margin-top: auto; border-top: 1px solid #ffffff1c; padding-top: 16px; font-size: 14px; color: #c4d0e7; }
.ko-artifact { display: block; margin-bottom: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 14px ui-monospace, monospace; color: #eef2ff; }
.ko-checks { display: flex; flex-wrap: wrap; gap: 5px 12px; color: #a3e6cb; }
.ko-hero-note { font-size: 14px; line-height: 1.7; color: #f3d5a3; overflow-wrap: anywhere; }
.ko-hero-note[data-error] { color: #ffb6ba; }
.ko-chart-card { min-width: 0; padding: 23px 24px 16px; }
.ko-section-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.ko-section-head h2 { font-size: 20px; margin: 0; font-weight: 600; }
.ko-section-head small { font-size: 14px; color: var(--ko-muted); margin-left: auto; }
.ko-chart-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--ko-muted); font-size: 14px; margin-bottom: 8px; }
.ko-chart { width: 100%; min-width: 0; }
.ko-chart svg { display: block; width: 100%; overflow: visible; }
.ko-chart [role=button] { cursor: pointer; }
.ko-chart [role=button]:focus { outline: none; }
.ko-chart [role=button]:focus-visible .ko-hit { stroke: var(--ko-accent); stroke-width: 2; }
.ko-chart-legend { display: flex; flex-wrap: wrap; gap: 10px 18px; color: var(--ko-muted); font-size: 14px; }
.ko-chart-legend span { display: inline-flex; align-items: center; gap: 5px; }
.ko-line-key { display: inline-block; width: 20px; height: 2px; background: currentColor; }
.ko-dot-key { width: 8px; height: 8px; border: 1.5px solid var(--dsw-alias-state-error-primary, #d93a3f); border-radius: 50%; }
.ko-inspector { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-height: 58px; padding: 12px 16px; margin: 14px 0 9px; border-radius: 9px; background: var(--ko-tint); font-size: 16px; font-variant-numeric: tabular-nums; }
.ko-inspector strong { font-size: 22px; font-weight: 600; }
.ko-inspector .ko-text-button { margin-left: auto; }
.ko-muted { color: var(--ko-muted); }
.ko-text-button { appearance: none; background: none; border: 0; padding: 0; color: var(--ko-accent); font-size: 14px; cursor: pointer; }
.ko-chart-explanation { font-size: 14px; color: var(--ko-muted); }
.ko-chart-explanation summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 4px 12px; list-style: none; }
.ko-chart-explanation summary::-webkit-details-marker { display: none; }
.ko-chart-explanation summary span:last-child { margin-left: auto; }
.ko-chart-explanation p { line-height: 1.75; margin: 8px 0 0; }
.ko-stats { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 28px; padding: 0 3px; }
.ko-stat { display: flex; align-items: baseline; gap: 8px; }
.ko-stat strong { font-size: 28px; font-weight: 550; font-variant-numeric: tabular-nums; }
.ko-stat span, .ko-device { font-size: 14px; color: var(--ko-muted); }
.ko-device { margin-left: auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ko-lower { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 18px; }
.ko-plan, .ko-recent { border: 1px solid var(--ko-border); border-radius: 13px; padding: 18px 20px; min-width: 0; background: var(--ko-surface); }
.ko-plan h3 { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin: 12px 0 8px; font-size: 18px; font-weight: 550; line-height: 1.65; overflow-wrap: anywhere; }
.ko-phase { font-size: 14px; padding: 2px 7px; color: var(--ko-accent); background: var(--ko-tint); border-radius: 4px; }
.ko-plan-copy { font-size: 16px; color: var(--ko-muted); overflow-wrap: anywhere; }
.ko-plan details { margin-top: 12px; font-size: 16px; color: var(--ko-muted); }
.ko-plan summary { cursor: pointer; }
.ko-recent-list { display: flex; flex-direction: column; }
.ko-recent-row { display: grid; grid-template-columns: 30px minmax(0,1fr) 84px 72px 60px; gap: 8px; align-items: center; width: 100%; padding: 10px 0; background: transparent; border: 0; border-top: 1px solid var(--ko-border); text-align: left; font-size: 16px; color: var(--ko-text); cursor: pointer; font-variant-numeric: tabular-nums; }
.ko-recent-row:first-child { border-top: 0; }
.ko-recent-file { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font: 14px ui-monospace, monospace; }
.ko-audit-toggle { display: flex; align-items: center; gap: 10px; width: 100%; padding: 14px 0; background: none; border: 0; border-top: 1px solid var(--ko-border); color: var(--ko-muted); text-align: left; cursor: pointer; }
.ko-audit-toggle strong { font-size: 14px; font-weight: 500; color: var(--ko-text); }
.ko-audit-toggle small { font-size: 14px; }
.ko-empty { padding: 48px 24px; border: 1px dashed var(--ko-border); border-radius: 16px; text-align: center; color: var(--ko-muted); }
.ko-empty h2 { font-size: 22px; color: var(--ko-text); margin: 16px 0 8px; }
.ko-empty p { max-width: 450px; margin: 0 auto; font-size: 16px; line-height: 1.8; }
.ko-empty svg { color: var(--ko-accent); }
@container kernel-panel (max-width: 890px) {
  .ko-overview { grid-template-columns: 250px minmax(0,1fr); }
  .ko-hero { padding: 24px 20px; }
  .ko-chart-card { padding: 20px 16px 14px; }
  .ko-lower { grid-template-columns: 1fr; }
  .ko-hero-number { font-size: 64px; }
}
@container kernel-panel (max-width: 760px) {
  .ko-overview { grid-template-columns: 1fr; }
  .ko-hero { display: grid; grid-template-columns: 1fr 1fr; gap: 16px 24px; }
  .ko-hero-number { font-size: 64px; }
  .ko-hero-footer, .ko-hero-note { grid-column: 1 / -1; }
  .ko-hero-footer { display: flex; flex-wrap: wrap; gap: 6px 16px; padding-top: 10px; }
  .ko-artifact { margin-bottom: 0; }
  .ko-lower { grid-template-columns: 1fr; }
  .ko-device { max-width: 100%; margin-left: 0; }
  .ko-audit-toggle small { display: none; }
}
@container kernel-panel (max-width: 520px) {
  .ko-header { flex-wrap: wrap; row-gap: 10px; }
  .ko-hero-number { font-size: 52px; }
  .ko-comparison-label { flex-wrap: wrap; gap: 0 8px; }
  .ko-section-head { flex-wrap: wrap; }
  .ko-recent-row { grid-template-columns: 28px minmax(0,1fr) auto; column-gap: 12px; }
  .ko-recent-file { grid-column: 2; }
  .ko-recent-row > span:nth-child(3) { grid-column: 3; }
  .ko-recent-row > strong { grid-column: 2; }
  .ko-recent-status { grid-column: 3; }
}
@media (max-width: 700px) { .ko-panel { padding: 18px 14px 24px; gap: 16px; } }
@keyframes kernelOptPulse { 0%, 100% { opacity: 1 } 50% { opacity: .3 } }
@keyframes kernelOptArrive { from { opacity: 0; transform: scale(.75) } to { opacity: 1; transform: scale(1) } }
@keyframes kernelOptHalo { from { opacity: .55; r: 4 } to { opacity: 0; r: 22 } }
@media (prefers-reduced-motion: reduce) {
  [style*="kernelOptPulse"], .kernel-opt-arrive { animation: none !important }
  .kernel-opt-halo { display: none }
  .ko-panel * { transition: none !important; }
}
`
