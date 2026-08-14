window.__ModuleLoader__.load({
	id: "@xietwim/dsh-kernel-opt",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/wire.ts
		/**
		* Whether two logged paths plausibly address the same file (exact, or one is
		* the other's path suffix). Shared protocol helper: the projection matches
		* changes/finalizes with it and the panel matches replay coverage.
		*/
		function samePath(a, b) {
			return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
		}
		/**
		* Index into `rounds` where the latest loop run begins. Every arm resets the
		* continuation counter, so a round number that does not increase past its
		* predecessor's opens a new run; wrap-up messages (no round number) stay with
		* the run they close. Shared protocol helper: the panel scopes its
		* supervision card to the current run with it, while the full history stays
		* on the wire.
		*/
		function latestRunStart(rounds) {
			let start = 0;
			let prev;
			for (let i = 0; i < rounds.length; i += 1) {
				const num = rounds[i]?.round;
				if (num === void 0) continue;
				if (prev !== void 0 && num <= prev) start = i;
				prev = num;
			}
			return start;
		}
		/**
		* Whether the iteration logged at `seq` belongs to a wrap-up phase: the
		* governing loop message above it is a wrap-up delivery or the closing audit,
		* so the evaluation is finalize verification or audit correction, not
		* budgeted optimization work. Only a numbered continuation (a new drive)
		* exits the phase. Shared protocol helper: the panel splits its chips and
		* badges rows with it, keeping "N iterations" aligned with the armed budget.
		*/
		function inWrapUpPhase(rounds, seq) {
			let phase = false;
			for (const round of rounds) {
				if (round.seq > seq) break;
				if (round.wrapUp === true || round.audit === true) phase = true;
				else if (round.round !== void 0) phase = false;
			}
			return phase;
		}
		/** Route the Node half serves and the panel polls (query: `?sessionId=`). */
		const SERIES_PATH = "/plugins/kernel-opt/series";
		/**
		* Control route. POST `{ sessionId, action, budget?, provider?, model? }`
		* with action one of `loop-arm` / `loop-stop` / `supervise-on` /
		* `supervise-off` / `supervise-use` (both provider+model set the session
		* override; both empty resets to config). GET `?sessionId=` returns the same
		* fresh {@link WireControl} without acting — the lightweight poll for the
		* chat-side loop affordances. The slash commands remain the scriptable twin
		* of the same state.
		*/
		const CONTROL_PATH = "/plugins/kernel-opt/control";
		/** Models route (GET): the {@link WireModels} catalog for the picker. */
		const MODELS_PATH = "/plugins/kernel-opt/models";
		//#endregion
		//#region src/client/index.tsx
		/**
		* dsh-kernel-opt — browser half.
		*
		* 「评测」 session tab (`conversation.view` slot): polls the Node half's
		* series route and renders the live optimization picture — latency curve over
		* evaluations (log scale when the journey is wide), correctness/reward-hack
		* status per point, profiler ▲ and finalize ★ marks, the model's latest
		* `kernel_plan`, and an iteration table. Pure projection of the session log;
		* a replayed session renders identically.
		* @module
		*/
		const NS = "kernel-opt";
		const zh = {
			"tab.label": "评测",
			"empty.title": "暂无评测数据",
			"empty.body": "Agent 每完成一次评测，这里会实时新增一个数据点并连成优化曲线，方案汇报与监督记录也在此展示；把 kernel 和评测方式告诉 Agent 即可开始。",
			"chips.iterations": "{count} 次迭代",
			"chips.best": "最佳 {latency}",
			"chips.profiles": "{count} 次 profile",
			"chips.hacks": "{count} 次作弊检出",
			"chips.pending": "评测中…",
			"plan.title": "当前方案",
			"plan.none": "Agent 尚未汇报优化方案。",
			"plan.next": "下一步",
			"plan.count": "第 {n} 次汇报",
			"plan.history": "查看此前 {n} 次汇报",
			"plan.hide": "收起历史汇报",
			"table.title": "迭代记录",
			"status.pending": "评测中",
			"status.ok": "通过",
			"status.wrong": "未通过",
			"status.hack": "作弊检出",
			"status.error": "失败",
			"axis.best": "最佳",
			"loop.armed": "循环运行中 · 已迭代 {done}/{budget} 次",
			"loop.stopped": "循环已停止：{reason}",
			"pop.budget": "迭代次数",
			"pop.supervise": "外部监督",
			"pop.model": "监督模型",
			"pop.supNote": "已开启：循环每次驱动 Agent 继续之前，监督模型会先复审当前进展，建议自动转交 Agent；Agent 在预算未用完时宣布完成，也由监督裁定是否还有优化空间。",
			"pop.footer": "启动后 Agent 立即开始工作；每当一段工作结束而任务尚未完成，循环会自动驱动它继续，直到迭代次数达到上限。输入框中的草稿不会被自动发送；优化曲线与完整记录见「评测」页。",
			"sup.on": "on",
			"sup.off": "off",
			"sup.needCfg": "未配置监督模型：请在下拉框中选择，或在插件 config 中添加 supervisor: { provider, model }",
			"sup.model": "监督模型",
			"sup.default": "默认：{route}",
			"sup.pick": "选择监督模型…",
			"ctl.start": "启动循环",
			"ctl.stop": "停止循环",
			"ctl.budget": "迭代次数",
			"ctl.title": "运行控制",
			"advice.title": "监督记录",
			"advice.waiting": "监督已开启：循环每次驱动 Agent 继续之前，监督模型会先复审当前进展；结论与建议会自动转交 Agent 并记录在此。",
			"advice.round": "第 {n} 次复审",
			"advice.earlier": "（此前循环的 {n} 条复审记录未显示，完整历史保留在会话日志中）",
			"reason.finalized": "已完成收尾",
			"reason.converged": "监督确认无进一步优化空间，已收尾",
			"reason.budget": "迭代次数已用完，已请求收尾",
			"reason.no-progress": "连续无进展，已请求收尾",
			"reason.stopped": "手动停止",
			"row.plan": "生效方案",
			"row.review": "监督意见",
			"row.metrics": "指标",
			"row.error": "错误",
			"row.blocking": "阻断项",
			"row.advisory": "提示项",
			"row.notMeasured": "未测得",
			"row.subset": "工作负载子集",
			"row.evaluatorFailed": "评测器故障（不构成对 kernel 的判定）",
			"row.changes": "本次改动",
			"row.write": "整文件写入",
			"row.edit": "替换",
			"row.truncated": "（已截断）",
			"row.channelShell": "Agent 测得",
			"row.channelReplay": "复测",
			"row.command": "来源命令",
			"row.unverifiedFinal": "最终数字未复测",
			"table.final": "最终",
			"row.wrapup": "收尾",
			"advice.wrapup": "收尾复审",
			"advice.audit": "终审",
			"advice.challenge": "早停质询",
			"advice.ok": "无异议",
			"advice.scopeRound": "审查循环纪律：预算使用是否合理、方案与实测是否一致、连续失败是否该换方向、数据来源是否可信。",
			"advice.scopeWrapup": "收尾前的最后一次复审：确认收尾时机与最终结果的数据来源。",
			"advice.scopeAudit": "收尾后的终审：核对最终表格与最终数字的来源（含插件复测）。",
			"advice.scopeChallenge": "Agent 在预算未用完时宣布完成，监督裁定是否还有优化空间；给出未尝试方向即推翻收尾，run 继续。",
			"advice.progress": "复审时进度",
			"advice.covers": "覆盖迭代",
			"advice.coversNone": "本次复审后暂无新迭代",
			"advice.verdict": "结论",
			"advice.expandHint": "点击展开查看该次复审的范围与结论",
			"ctl.supDep": "监督只在循环的检查点运行，启动循环后才会触发。",
			"ctl.supOff": "未开启监督：Agent 自行判断何时收尾，循环仅保留预算与停滞兜底。",
			"ctl.supOn": "每次驱动前先复审；Agent 提前收尾时，由监督裁定是否还有优化空间。",
			"chips.wrapup": "收尾评测 {count} 次",
			"tip.iters": "循环内完成的优化迭代（不含收尾评测）",
			"tip.wrapup": "循环结束后的收尾评测（最终验证与复测），不计入迭代预算",
			"tip.replay": "插件对最终版本重放评测命令独立测得",
			"row.channelTool": "工具",
			"tip.tool": "由注册评测工具直接返回，非 Agent 转述",
			"tip.final": "收尾时选定的最终版本",
			"tip.best": "当前最优结果",
			"tip.ok": "正确性校验通过"
		};
		const en = {
			"tab.label": "Evaluations",
			"empty.title": "No evaluations yet",
			"empty.body": "Each completed evaluation adds a live point to the optimization curve here, along with plan reports and supervision notes; hand the agent a kernel and a way to evaluate it to begin.",
			"chips.iterations": "{count} iterations",
			"chips.best": "best {latency}",
			"chips.profiles": "{count} profiles",
			"chips.hacks": "{count} reward-hacks caught",
			"chips.pending": "evaluating…",
			"plan.title": "Current plan",
			"plan.none": "The agent has not reported an optimization plan yet.",
			"plan.next": "Next",
			"plan.count": "report #{n}",
			"plan.history": "show {n} earlier reports",
			"plan.hide": "hide earlier reports",
			"table.title": "Iterations",
			"status.pending": "running",
			"status.ok": "ok",
			"status.wrong": "wrong",
			"status.hack": "reward-hack",
			"status.error": "failed",
			"axis.best": "best",
			"loop.armed": "loop running · {done}/{budget} iterations",
			"loop.stopped": "loop stopped: {reason}",
			"pop.budget": "Max iterations",
			"pop.supervise": "External supervision",
			"pop.model": "Supervisor model",
			"pop.supNote": "On: before the loop drives the agent onward, the supervisor reviews progress first and its advice is handed to the agent; when the agent declares itself finished with budget left, the supervisor rules on whether headroom remains.",
			"pop.footer": "Starting puts the agent to work immediately; whenever it stops with the task unfinished, the loop drives it onward until the iteration limit is reached. Composer drafts are never auto-sent; the curve and full record live on the Evaluations tab.",
			"sup.on": "on",
			"sup.off": "off",
			"sup.needCfg": "No supervisor model configured: pick one below, or add supervisor: { provider, model } to the plugin config",
			"sup.model": "Supervisor model",
			"sup.default": "default: {route}",
			"sup.pick": "pick a supervisor model…",
			"ctl.start": "Start loop",
			"ctl.stop": "Stop loop",
			"ctl.budget": "Max iterations",
			"ctl.title": "Run controls",
			"advice.title": "Supervision log",
			"advice.waiting": "Supervision on: before each continuation the supervisor reviews progress first; its conclusions and advice are handed to the agent and recorded here.",
			"advice.round": "review {n}",
			"advice.earlier": "({n} review records from earlier loop runs hidden; the full history stays in the session log)",
			"reason.finalized": "finalized",
			"reason.converged": "supervisor confirmed no further headroom; wrapped up",
			"reason.budget": "iteration limit reached, wrap-up requested",
			"reason.no-progress": "stalled, wrap-up requested",
			"reason.stopped": "stopped manually",
			"row.plan": "Plan in effect",
			"row.review": "Supervisor advice",
			"row.metrics": "Metrics",
			"row.error": "Error",
			"row.blocking": "Blocking",
			"row.advisory": "Advisory",
			"row.notMeasured": "Not measured",
			"row.subset": "Workload subset",
			"row.evaluatorFailed": "Evaluator failed (not a verdict on the kernel)",
			"row.changes": "Changes this iteration",
			"row.write": "full write",
			"row.edit": "edit",
			"row.truncated": "(truncated)",
			"row.channelShell": "agent-measured",
			"row.channelReplay": "replayed",
			"row.command": "Command",
			"row.unverifiedFinal": "final number not replayed",
			"table.final": "final",
			"row.wrapup": "wrap-up",
			"advice.wrapup": "wrap-up review",
			"advice.audit": "final review",
			"advice.challenge": "early-stop challenge",
			"advice.ok": "no objection",
			"advice.scopeRound": "Audits loop discipline: budget spend, plans vs measurements, family switches after repeated failure, and provenance.",
			"advice.scopeWrapup": "The last review before wrap-up: whether it is time to finish, and where the final numbers came from.",
			"advice.scopeAudit": "Post-finalize audit: the final table and the provenance of the final number (including the plugin replay).",
			"advice.scopeChallenge": "The agent declared it finished with budget left; the supervisor ruled on remaining headroom — naming untried directions overrules the finalize and the run continues.",
			"advice.progress": "Progress at review",
			"advice.covers": "Covers iterations",
			"advice.coversNone": "No new iterations since this review",
			"advice.verdict": "Verdict",
			"advice.expandHint": "Click a row to see what that review covered and concluded",
			"ctl.supDep": "Supervision runs at the loop's checkpoints — it only fires once the loop is started.",
			"ctl.supOff": "Off: the agent decides when to wrap up; the loop keeps only its budget and stall guards.",
			"ctl.supOn": "Reviews before each continuation, and rules on remaining headroom when the agent wraps up early.",
			"chips.wrapup": "{count} wrap-up checks",
			"tip.iters": "Optimization iterations completed in the loop (wrap-up checks excluded)",
			"tip.wrapup": "Wrap-up evaluation after the loop ended (final verification / replay); not counted against the iteration budget",
			"tip.replay": "Measured by the plugin replaying the evaluation command against the final version",
			"row.channelTool": "tool",
			"tip.tool": "Returned directly by a registered evaluator tool, not agent-relayed",
			"tip.final": "The final version selected at wrap-up",
			"tip.best": "Best result so far",
			"tip.ok": "Correctness check passed"
		};
		/** Poll cadence — the panel is a dashboard, not a ticker. */
		const POLL_MS = 1500;
		/**
		* Palette: official alias tokens with safe fallbacks. Secondary text rides
		* primary-dimmed/tertiary (not caption) — caption-tier gray proved too light
		* against the panel cards in the field.
		*/
		const COLOR = {
			text: "var(--dsw-alias-label-primary, #1f2329)",
			dim: "var(--dsw-alias-label-primary-dimmed, #3d444d)",
			caption: "var(--dsw-alias-label-tertiary, #5a6270)",
			border: "var(--dsw-alias-border-l1, rgba(0,0,0,.12))",
			borderL2: "var(--dsw-alias-border-l2, rgba(0,0,0,.15))",
			inputBg: "var(--dsw-alias-bg-layer-1, #fff)",
			primaryFill: "var(--dsw-alias-button-primary-fill, #4d6bfe)",
			primaryText: "var(--dsw-alias-label-primary-foreground, #fff)",
			menuBg: "var(--dsw-specific-menu, #fff)",
			menuBorder: "var(--dsw-alias-border-inverted, rgba(0,0,0,.08))",
			tip: "var(--dsw-specific-tip, rgba(77,107,254,.06))",
			/** Halo painted behind in-plot chart text so the curve cannot cut through it. */
			halo: "var(--dsw-alias-bg-layer-1, #fff)",
			curve: "var(--dsw-specific-primary, #4d6bfe)",
			ok: "#1f8f5f",
			bad: "#d93a3f",
			warn: "#d18a1f"
		};
		/** Elevated-surface shadow (host menu dropdowns use shadow-lv3). */
		const MENU_SHADOW = "var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.14))";
		/** Session-scoped polling hook for the panel series (+ manual refetch). */
		/** One-shot fetch of the supervisor model catalog (picker options). */
		function useModels() {
			const [models, setModels] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let alive = true;
				(async () => {
					try {
						const res = await fetch(MODELS_PATH, { headers: { accept: "application/json" } });
						if (!res.ok) return;
						const data = await res.json();
						if (alive && Array.isArray(data.providers)) setModels(data);
					} catch {}
				})();
				return () => {
					alive = false;
				};
			}, []);
			return models;
		}
		/**
		* Lightweight control-state poll (GET on the control route) for the
		* chat-side loop affordances — a fraction of the series payload, so the
		* composer seats can poll without dragging the full iteration table along.
		*/
		function useControl(sessionId, pollMs = 2e3) {
			const [control, setControl] = (0, react.useState)(null);
			const [tick, setTick] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				let alive = true;
				const pull = async () => {
					try {
						const res = await fetch(`${CONTROL_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
						if (!res.ok) return;
						const data = await res.json();
						if (alive && data.control !== void 0) setControl(data.control);
					} catch {}
				};
				pull();
				const timer = setInterval(() => {
					pull();
				}, pollMs);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [
				sessionId,
				pollMs,
				tick
			]);
			return {
				control,
				refetch: () => {
					setTick((value) => value + 1);
				}
			};
		}
		function useSeries(sessionId) {
			const [series, setSeries] = (0, react.useState)(null);
			const [tick, setTick] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				let alive = true;
				const poll = async () => {
					try {
						const res = await fetch(`${SERIES_PATH}?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
						if (!res.ok) return;
						const data = await res.json();
						if (alive && Array.isArray(data.iterations)) setSeries(data);
					} catch {}
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, POLL_MS);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [sessionId, tick]);
			return {
				series,
				refetch: () => setTick((n) => n + 1)
			};
		}
		/** Human latency: µs under 1 ms, ms under 1 s, s above. */
		function formatLatency(ms) {
			if (ms < 1) return `${(ms * 1e3).toPrecision(3)}µs`;
			if (ms < 1e3) return `${ms.toPrecision(4)}ms`;
			return `${(ms / 1e3).toPrecision(3)}s`;
		}
		/** Status classification of one iteration for color and label. */
		function statusOf(point) {
			if (point.pending === true) return "pending";
			if (point.rewardHack === true) return "hack";
			if (point.error !== void 0) return "error";
			if (point.correct === true) return "ok";
			return "wrong";
		}
		const STATUS_COLOR = {
			pending: COLOR.caption,
			ok: COLOR.ok,
			wrong: COLOR.bad,
			hack: COLOR.warn,
			error: COLOR.bad
		};
		/** Chart geometry constants (viewBox units). */
		const CHART = {
			w: 640,
			h: 200,
			l: 56,
			r: 16,
			t: 16,
			b: 26
		};
		/** Minimum vertical clearance between two axis-gutter labels (viewBox units). */
		const AXIS_GAP = 13;
		/** Nearest-rank quantile of an ascending-sorted array. */
		function quantile(sorted, q) {
			return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? 0;
		}
		/**
		* Build the y mapping from the measured latencies. The domain focuses on the
		* convergence band [best × 0.97, P90 × 1.25]: a run whose early exploration
		* sits far above its converged band would otherwise compress every later
		* improvement into a flat line, log axis or not. Points above the band stay
		* visible, pinned to the top edge with an ↑ mark and the maximum labeled.
		*/
		function chartModel(measured, count) {
			const sorted = measured.map((p) => p.latencyMs).filter((v) => v !== void 0).sort((a, b) => a - b);
			if (sorted.length === 0) return null;
			const min = sorted[0] ?? 0;
			const max = sorted[sorted.length - 1] ?? 0;
			let hi = max;
			if (sorted.length >= 6) {
				const band = quantile(sorted, .9) * 1.25;
				if (band < hi) hi = band;
			}
			hi *= 1.015;
			const lo = min * .97;
			const log = lo > 0 && hi / lo > 20;
			const toAxis = (v) => log ? Math.log10(v) : v;
			const axLo = toAxis(lo);
			const span = toAxis(hi) - axLo || 1;
			const innerW = CHART.w - CHART.l - CHART.r;
			const innerH = CHART.h - CHART.t - CHART.b;
			const denom = Math.max(1, count - 1);
			const xPad = 14;
			return {
				x: (index) => CHART.l + xPad + (innerW - 28) * index / denom,
				y: (latencyMs) => {
					const v = Math.min(toAxis(latencyMs), axLo + span);
					return CHART.t + innerH * (1 - (v - axLo) / span);
				},
				clamped: (latencyMs) => latencyMs > hi,
				log,
				lo,
				hi,
				max,
				atFraction: (f) => {
					const v = axLo + span * f;
					return log ? 10 ** v : v;
				}
			};
		}
		/** Latency curve with per-point status, best line, profile ▲ and finalize ★. */
		function Chart(props) {
			const { series, bestLabel, statusLabel } = props;
			const { iterations, profileSeqs, bestIndex } = series;
			const model = (0, react.useMemo)(() => chartModel(iterations, iterations.length), [iterations]);
			if (model === null) return null;
			const maxClampedIndex = iterations.findIndex((p) => p.latencyMs === model.max && model.clamped(p.latencyMs));
			const best = bestIndex !== null ? iterations[bestIndex] : void 0;
			const bestY = best?.latencyMs !== void 0 ? model.y(best.latencyMs) : Number.NEGATIVE_INFINITY;
			const linePoints = iterations.map((p, i) => p.latencyMs !== void 0 ? `${model.x(i).toFixed(1)},${model.y(p.latencyMs).toFixed(1)}` : null).filter((s) => s !== null).join(" ");
			const profileXs = profileSeqs.map((seq) => {
				let before = -1;
				for (let i = 0; i < iterations.length; i += 1) {
					const it = iterations[i];
					if (it !== void 0 && it.seq < seq) before = i;
				}
				const after = Math.min(before + 1, iterations.length - 1);
				const frac = before < 0 ? 0 : before === after ? 1 : .5;
				return model.x(Math.max(0, before)) + (model.x(after) - model.x(Math.max(0, before))) * frac;
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: `0 0 ${CHART.w} ${CHART.h}`,
				style: {
					width: "100%",
					height: "auto",
					display: "block"
				},
				role: "img",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: CHART.l,
						y1: CHART.t,
						x2: CHART.l,
						y2: CHART.h - CHART.b,
						stroke: COLOR.border,
						strokeWidth: 1
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: CHART.l,
						y1: CHART.h - CHART.b,
						x2: CHART.w - CHART.r,
						y2: CHART.h - CHART.b,
						stroke: COLOR.border,
						strokeWidth: 1
					}),
					Math.abs(CHART.t - bestY) >= AXIS_GAP ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: CHART.l - 6,
						y: CHART.t + 4,
						textAnchor: "end",
						fontSize: 12,
						fill: COLOR.dim,
						children: formatLatency(model.hi)
					}) : null,
					Math.abs(CHART.h - CHART.b - bestY) >= AXIS_GAP ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: CHART.l - 6,
						y: CHART.h - CHART.b,
						textAnchor: "end",
						fontSize: 12,
						fill: COLOR.dim,
						children: formatLatency(model.lo)
					}) : null,
					model.log ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: CHART.l - 6,
						y: (CHART.t + CHART.h - CHART.b) / 2 + 14,
						textAnchor: "end",
						fontSize: 11,
						fill: COLOR.caption,
						children: "log"
					}) : null,
					[
						.25,
						.5,
						.75
					].map((f) => {
						const value = model.atFraction(f);
						const gy = model.y(value);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
							x1: CHART.l,
							x2: CHART.w - CHART.r,
							y1: gy,
							y2: gy,
							stroke: COLOR.border,
							strokeWidth: 1,
							strokeDasharray: "2 5",
							opacity: .55
						}), f === .5 && Math.abs(gy - bestY) >= AXIS_GAP ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
							x: CHART.l - 6,
							y: gy + 4,
							textAnchor: "end",
							fontSize: 10,
							fill: COLOR.caption,
							children: formatLatency(value)
						}) : null] }, `g${String(f)}`);
					}),
					best?.latencyMs !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("title", { children: `${bestLabel} ${formatLatency(best.latencyMs)}` }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
							x1: CHART.l,
							x2: CHART.w - CHART.r,
							y1: bestY,
							y2: bestY,
							stroke: COLOR.ok,
							strokeWidth: 1,
							strokeDasharray: "4 4",
							opacity: .6
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
							x: CHART.l - 6,
							y: bestY + 4,
							textAnchor: "end",
							fontSize: 12,
							fontWeight: 500,
							fill: COLOR.ok,
							children: formatLatency(best.latencyMs)
						})
					] }) : null,
					linePoints.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("polyline", {
						points: linePoints,
						fill: "none",
						stroke: COLOR.curve,
						strokeWidth: 1.6,
						opacity: .9
					}) : null,
					iterations.map((p, i) => {
						const status = statusOf(p);
						const color = STATUS_COLOR[status];
						const cx = model.x(i);
						const finalPick = p.finalized === true && p.channel !== "replay";
						const marks = `${bestIndex === i ? " ★" : ""}${finalPick ? " ⚑" : ""}`;
						const tip = `#${String(i + 1)} · ${p.latencyMs !== void 0 ? formatLatency(p.latencyMs) : "—"} · ${statusLabel(status)}${marks}`;
						if (p.latencyMs === void 0) {
							const cy = CHART.h - CHART.b + 8;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("title", { children: tip }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
								cx,
								cy,
								r: 3.5,
								fill: "none",
								stroke: color,
								strokeWidth: 1.5,
								children: status === "pending" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("animate", {
									attributeName: "opacity",
									values: "1;0.25;1",
									dur: "1.2s",
									repeatCount: "indefinite"
								}) : null
							})] }, p.seq);
						}
						const cy = model.y(p.latencyMs);
						const isBest = bestIndex === i;
						const clamped = model.clamped(p.latencyMs);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("title", { children: tip }),
							status === "ok" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
								cx,
								cy,
								r: 3.5,
								fill: color
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
								cx,
								cy,
								r: 3.5,
								fill: "none",
								stroke: color,
								strokeWidth: 1.8
							}),
							clamped ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
								x: cx,
								y: CHART.t - 4,
								textAnchor: "middle",
								fontSize: 9,
								fill: COLOR.caption,
								children: "↑"
							}) : null,
							clamped && i === maxClampedIndex ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("text", {
								x: cx < CHART.w / 2 ? cx + 7 : cx - 7,
								y: CHART.t + 4,
								textAnchor: cx < CHART.w / 2 ? "start" : "end",
								fontSize: 11,
								fill: COLOR.dim,
								stroke: COLOR.halo,
								strokeWidth: 3,
								paintOrder: "stroke",
								children: [formatLatency(model.max), "↑"]
							}) : null,
							isBest ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
								x: cx,
								y: cy - 8,
								textAnchor: "middle",
								fontSize: 13,
								fill: COLOR.ok,
								children: "★"
							}) : null,
							finalPick ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
								x: cx,
								y: cy - (isBest ? 21 : 8),
								textAnchor: "middle",
								fontSize: 12,
								fill: COLOR.curve,
								children: "⚑"
							}) : null
						] }, p.seq);
					}),
					profileXs.map((x, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x,
						y: CHART.h - CHART.b + 13,
						textAnchor: "middle",
						fontSize: 10,
						fill: COLOR.caption,
						children: "▲"
					}, `p${String(i)}`))
				]
			});
		}
		const chipStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			padding: "2px 10px",
			borderRadius: 999,
			border: `1px solid ${COLOR.border}`,
			fontSize: 13,
			lineHeight: "22px",
			color: COLOR.dim,
			whiteSpace: "nowrap"
		};
		const cardStyle = {
			border: `1px solid ${COLOR.border}`,
			borderRadius: 12,
			background: COLOR.tip,
			padding: "14px 16px"
		};
		/** Chip-shaped select for the supervisor model picker. */
		/**
		* Compact capsule button, after the host Button primitive's `sm` geometry
		* (h28 / r14 / 12px, borderless). `outline`/`primary` variants below mirror
		* the host's variant fills.
		*/
		const capsuleStyle = {
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			gap: 4,
			height: 28,
			padding: "0 12px",
			border: "none",
			borderRadius: 14,
			fontSize: 12,
			lineHeight: "18px",
			fontFamily: "inherit",
			whiteSpace: "nowrap",
			color: COLOR.text,
			background: "transparent",
			cursor: "pointer"
		};
		/** Outline capsule (host dialog-cancel variant); accent colors border + text. */
		function buttonStyle(accent) {
			return {
				...capsuleStyle,
				border: `1px solid ${accent ?? COLOR.borderL2}`,
				...accent !== void 0 ? { color: accent } : {}
			};
		}
		/**
		* Filled primary capsule — the send button's exact recipe (`button-info-fill`
		* + static white glyph; the `button-primary-fill` token resolves to ink and
		* reads far too heavy here). Gated/disabled renders at opacity 0.4, which is
		* also how the send circle gets its soft pre-send blue.
		*/
		const primaryBtnStyle = {
			...capsuleStyle,
			background: "var(--dsw-alias-button-info-fill, #4d6bfe)",
			color: "#fff"
		};
		/** Disabled dressing for either button variant. */
		const disabledBtnStyle = {
			opacity: .4,
			cursor: "not-allowed"
		};
		/** Field geometry after the host Input primitive (r8, l2 border, layer-1 bg). */
		const fieldStyle = {
			height: 28,
			padding: "0 8px",
			borderRadius: 8,
			border: `1px solid ${COLOR.borderL2}`,
			background: COLOR.inputBg,
			fontSize: 12,
			fontFamily: "inherit",
			color: COLOR.text,
			outline: "none"
		};
		const selectStyle = {
			...fieldStyle,
			cursor: "pointer",
			maxWidth: 260
		};
		const inputStyle = {
			...fieldStyle,
			width: 64
		};
		/** Inline control label (循环次数 / 外部监督 / 监督模型). */
		const rowLabelStyle = {
			flex: "none",
			fontSize: 12,
			color: COLOR.dim
		};
		/** Popover card, after the host MenuDropdown surface (r12, lv3 shadow). */
		const popoverStyle = {
			position: "absolute",
			bottom: "calc(100% + 8px)",
			left: 0,
			zIndex: 41,
			minWidth: 264,
			display: "flex",
			flexDirection: "column",
			gap: 10,
			padding: 12,
			border: `1px solid ${COLOR.menuBorder}`,
			borderRadius: 12,
			background: COLOR.menuBg,
			boxShadow: MENU_SHADOW,
			fontFamily: "system-ui",
			fontSize: 13,
			color: COLOR.text
		};
		/** One labeled row inside the popover. */
		const popoverRowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12
		};
		/** Monospace block for kernel text/diff halves; accent = left-border meaning. */
		function preStyle(accent) {
			return {
				margin: 0,
				padding: "6px 8px",
				fontSize: 12,
				lineHeight: "18px",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				maxHeight: 220,
				overflowY: "auto",
				background: "rgba(127,127,127,.08)",
				borderRadius: 6,
				borderLeft: `3px solid ${accent ?? COLOR.border}`,
				color: COLOR.text
			};
		}
		const sectionLabel = {
			fontSize: 12,
			fontWeight: 600,
			color: COLOR.dim,
			marginBottom: 2
		};
		/** Metric number formatting: integers verbatim, floats to 4 significant digits. */
		function formatMetric(value) {
			return Number.isInteger(value) ? String(value) : value.toPrecision(4);
		}
		/** Latest plan stated before a log position, if any. */
		function planBefore(plans, seq) {
			let found;
			for (const plan of plans) if (plan.seq < seq) found = plan;
			return found;
		}
		/** Latest reviewed loop round delivered before a log position, if any. */
		function reviewBefore(rounds, seq) {
			let found;
			for (const round of rounds) if (round.seq < seq && round.review !== void 0) found = round;
			return found;
		}
		/** Which kind of review a round carries, for its label and scope note. */
		function reviewKind(round) {
			if (round.audit === true) return "audit";
			if (round.challenge === true) return "challenge";
			if (round.wrapUp === true) return "wrapup";
			return "round";
		}
		/**
		* Expanded detail of one supervision record. A verdict alone ("OK") tells the
		* reader nothing, so the row opens into what that review actually was: which
		* question the supervisor was answering, the iterations it covered (the log
		* span since the previous review), the progress at the time, and the verdict
		* in full.
		*/
		function ReviewDetail(props) {
			const { round, rounds, iterations, t } = props;
			const kind = reviewKind(round);
			const scope = {
				audit: "advice.scopeAudit",
				challenge: "advice.scopeChallenge",
				wrapup: "advice.scopeWrapup",
				round: "advice.scopeRound"
			};
			const priorSeq = rounds.filter((r) => r.review !== void 0 && r.seq < round.seq).reduce((seq, r) => Math.max(seq, r.seq), -1);
			const covered = iterations.map((p, i) => ({
				p,
				n: i + 1
			})).filter(({ p }) => p.seq > priorSeq && p.seq < round.seq);
			const first = covered[0]?.n;
			const last = covered[covered.length - 1]?.n;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: "6px 4px 10px 66px",
					display: "flex",
					flexDirection: "column",
					gap: 6,
					fontSize: 12,
					color: COLOR.dim
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { color: COLOR.caption },
						children: t(scope[kind])
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						t("advice.covers"),
						"：",
						first === void 0 ? t("advice.coversNone") : first === last ? `#${String(first)}` : `#${String(first)} – #${String(last)}`,
						round.evalsUsed !== void 0 && round.budget !== void 0 ? ` · ${t("advice.progress")} ${String(round.evalsUsed)}/${String(round.budget)}` : ""
					] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							color: COLOR.text,
							whiteSpace: "pre-wrap"
						},
						children: [
							t("advice.verdict"),
							"：",
							round.review === "ok" ? `✓ ${t("advice.ok")}${round.reviewNote !== void 0 ? ` — ${round.reviewNote}` : ""}` : round.review
						]
					})
				]
			});
		}
		/** One structured artifact change, rendered as labeled monospace blocks. */
		function ChangeBlock(props) {
			const { change, t } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: { marginBottom: 6 },
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						fontSize: 12,
						color: COLOR.caption,
						margin: "2px 0"
					},
					children: [
						t(change.kind === "write" ? "row.write" : "row.edit"),
						" · ",
						change.tool,
						change.replaceAll === true ? " · replace_all" : "",
						change.truncated === true ? ` ${t("row.truncated")}` : ""
					]
				}), change.kind === "write" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
					style: preStyle(),
					children: change.content
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						flexDirection: "column",
						gap: 4
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						style: preStyle(COLOR.bad),
						children: change.oldText
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						style: preStyle(COLOR.ok),
						children: change.newText
					})]
				})]
			});
		}
		/**
		* Expanded detail of one iteration: the evaluator's full verdict, the plan
		* and supervision in effect when it ran, and the artifact changes that led
		* into it — all recovered from the session log.
		*/
		function IterationDetail(props) {
			const { point, plans, rounds, t, unverifiedFinal } = props;
			const plan = planBefore(plans, point.seq);
			const review = reviewBefore(rounds, point.seq);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: "8px 14px 12px 40px",
					borderBottom: `1px solid ${COLOR.border}`,
					display: "flex",
					flexDirection: "column",
					gap: 8,
					fontSize: 13
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							color: COLOR.caption,
							fontSize: 12
						},
						children: [
							point.tool,
							" · seq ",
							point.seq,
							point.channel !== void 0 ? ` · ${t(point.channel === "replay" ? "row.channelReplay" : "row.channelShell")}` : "",
							point.artifactPath !== void 0 ? ` · ${point.artifactPath}` : "",
							point.workloadSubset !== void 0 ? ` · ${t("row.subset")} [${point.workloadSubset.join(", ")}]` : ""
						]
					}),
					unverifiedFinal === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							color: COLOR.warn,
							fontSize: 12
						},
						children: ["⚠ ", t("row.unverifiedFinal")]
					}) : null,
					point.command !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sectionLabel,
						children: t("row.command")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						style: preStyle(COLOR.border),
						children: point.command
					})] }) : null,
					point.evaluatorFailed === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { color: COLOR.warn },
						children: t("row.evaluatorFailed")
					}) : null,
					point.error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sectionLabel,
						children: t("row.error")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
						style: preStyle(COLOR.bad),
						children: point.error
					})] }) : null,
					point.blocking !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sectionLabel,
						children: t("row.blocking")
					}), point.blocking.map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 12,
							color: COLOR.bad
						},
						children: ["· ", line]
					}, index))] }) : null,
					point.advisory !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sectionLabel,
						children: t("row.advisory")
					}), point.advisory.map((line, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 12,
							color: COLOR.dim
						},
						children: ["· ", line]
					}, index))] }) : null,
					point.notMeasured !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							fontSize: 12,
							color: COLOR.caption
						},
						children: [
							t("row.notMeasured"),
							": ",
							point.notMeasured.join(", ")
						]
					}) : null,
					point.metrics !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sectionLabel,
						children: t("row.metrics")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							display: "flex",
							flexWrap: "wrap",
							gap: 6
						},
						children: Object.entries(point.metrics).map(([key, value]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								...chipStyle,
								fontSize: 12,
								lineHeight: "18px",
								padding: "1px 8px"
							},
							children: [
								key,
								" = ",
								formatMetric(value)
							]
						}, key))
					})] }) : null,
					plan !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sectionLabel,
						children: t("row.plan")
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: { color: COLOR.dim },
						children: [
							"[",
							plan.phase,
							"] ",
							plan.approach
						]
					})] }) : null,
					review !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sectionLabel,
						children: t("row.review")
					}), review.review === "ok" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: { color: COLOR.ok },
						children: "✓ OK"
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							color: COLOR.dim,
							whiteSpace: "pre-wrap"
						},
						children: review.review
					})] }) : null,
					point.changes !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: sectionLabel,
						children: t("row.changes")
					}), point.changes.map((change) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChangeBlock, {
						change,
						t
					}, change.seq))] }) : null
				]
			});
		}
		/**
		* Supervision on/off capsule, shared by the panel row and the launch
		* popover. Unconfigured (no config route, no session override) renders
		* disabled with the how-to in its tooltip.
		*/
		function SuperviseToggle(props) {
			const { control, t, onToggle } = props;
			const enabled = control.supervisor.enabled;
			const configured = control.supervisor.configured;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				style: {
					...buttonStyle(enabled ? COLOR.curve : void 0),
					...configured ? {} : disabledBtnStyle
				},
				disabled: !configured,
				title: configured ? void 0 : t("sup.needCfg"),
				onClick: onToggle,
				children: t(enabled ? "sup.on" : "sup.off")
			});
		}
		/**
		* Supervisor-model picker, shared by the panel row and the launch popover.
		* Two-layer semantics: '' = the plugin-config default (labeled with the
		* actual route when one is configured), any other value = session override.
		*/
		function SupervisorSelect(props) {
			const { control, models, t, onUse } = props;
			const effective = control.supervisor.effective;
			const overrideValue = effective !== void 0 && effective.source === "session" ? `${effective.provider}/${effective.model}` : "";
			const providers = models?.providers ?? [];
			const known = providers.flatMap((p) => p.models.map((m) => `${p.id}/${m.id}`));
			const displayName = (provider, model) => {
				for (const p of providers) {
					if (p.id !== provider) continue;
					const match = p.models.find((m) => m.id === model);
					if (match !== void 0) return match.name;
				}
				return `${provider}/${model}`;
			};
			const configRoute = control.supervisor.configRoute;
			const defaultLabel = configRoute !== void 0 ? t("sup.default", { route: displayName(configRoute.provider, configRoute.model) }) : t("sup.pick");
			const optionsFor = (provider) => provider.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
				value: `${provider.id}/${model.id}`,
				children: model.name
			}, `${provider.id}/${model.id}`));
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
				value: overrideValue,
				title: t("sup.model"),
				style: {
					...selectStyle,
					...props.style
				},
				onChange: (event) => {
					const value = event.target.value;
					if (value === "") {
						onUse("", "");
						return;
					}
					const slash = value.indexOf("/");
					onUse(value.slice(0, slash), value.slice(slash + 1));
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "",
						children: defaultLabel
					}),
					overrideValue !== "" && !known.includes(overrideValue) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: overrideValue,
						children: overrideValue
					}) : null,
					providers.length === 1 && providers[0] !== void 0 ? optionsFor(providers[0]) : providers.map((provider) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("optgroup", {
						label: provider.name,
						children: optionsFor(provider)
					}, provider.id))
				]
			});
		}
		/** The evaluation tab. */
		function KernelOptTab(props) {
			const { t, sessionId } = props;
			const { series, refetch } = useSeries(sessionId);
			const models = useModels();
			const [budgetDraft, setBudgetDraft] = (0, react.useState)(null);
			const [expandedSeq, setExpandedSeq] = (0, react.useState)(null);
			const [expandedReview, setExpandedReview] = (0, react.useState)(null);
			const [planHistory, setPlanHistory] = (0, react.useState)(false);
			/** Drive the control route, then re-pull so the panel reflects it now. */
			const post = async (action, extra) => {
				try {
					await fetch(CONTROL_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							sessionId,
							action,
							...extra
						})
					});
				} catch {}
				refetch();
			};
			const iterations = series?.iterations ?? [];
			const plans = series?.plans ?? [];
			const rounds = series?.rounds ?? [];
			const control = series?.control;
			const latestPlan = plans.length > 0 ? plans[plans.length - 1] : void 0;
			const best = series !== null && series.bestIndex !== null ? iterations[series.bestIndex] : void 0;
			const hackCount = iterations.filter((p) => p.rewardHack === true).length;
			const pendingCount = iterations.filter((p) => p.pending === true).length;
			const budgetValue = budgetDraft ?? String(control !== void 0 && control.loop.budget > 0 ? control.loop.budget : control?.loop.defaultBudget ?? 20);
			const runStart = latestRunStart(rounds);
			const reviewedRounds = rounds.slice(runStart).filter((r) => r.review !== void 0);
			const earlierReviews = rounds.slice(0, runStart).filter((r) => r.review !== void 0).length;
			const wrapUpChecks = iterations.filter((p) => p.channel === "replay" || inWrapUpPhase(rounds, p.seq)).length;
			const reasonLabel = (reason) => reason === "finalized" || reason === "converged" || reason === "budget" || reason === "no-progress" || reason === "stopped" ? t(`reason.${reason}`) : reason;
			const empty = iterations.length === 0 && plans.length === 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: "20px 20px 28px",
					maxWidth: 860,
					margin: "0 auto",
					display: "flex",
					flexDirection: "column",
					gap: 20,
					fontFamily: "system-ui",
					color: COLOR.text
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...cardStyle,
							display: "flex",
							flexDirection: "column",
							gap: 10
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 14,
									fontWeight: 600
								},
								children: t("ctl.title")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									flexWrap: "wrap",
									gap: 8,
									alignItems: "center"
								},
								children: [control?.loop.armed === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										fontSize: 13,
										color: COLOR.curve,
										fontWeight: 500
									},
									children: ["⟳ ", t("loop.armed", {
										round: control.loop.round,
										done: control.loop.evalsDone,
										budget: control.loop.budget
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									style: buttonStyle(COLOR.bad),
									onClick: () => {
										post("loop-stop");
									},
									children: ["■ ", t("ctl.stop")]
								})] }) : null, control !== void 0 && control.loop.armed === false && control.loop.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: rowLabelStyle,
										children: t("pop.budget")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "number",
										min: 1,
										max: 9999,
										value: budgetValue,
										title: t("ctl.budget"),
										style: inputStyle,
										onChange: (event) => {
											setBudgetDraft(event.target.value);
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
										type: "button",
										style: primaryBtnStyle,
										onClick: () => {
											const budget = Number(budgetValue);
											post("loop-arm", Number.isInteger(budget) && budget > 0 ? { budget } : {});
										},
										children: ["⟳ ", t("ctl.start")]
									}),
									control.loop.stopReason !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 12,
											color: COLOR.caption
										},
										children: t("loop.stopped", { reason: reasonLabel(control.loop.stopReason) })
									}) : null
								] }) : null]
							}),
							control !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									flexWrap: "wrap",
									gap: 8,
									alignItems: "center"
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: rowLabelStyle,
										children: t("pop.supervise")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SuperviseToggle, {
										control,
										t,
										onToggle: () => {
											post(control.supervisor.enabled ? "supervise-off" : "supervise-on");
										}
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											...rowLabelStyle,
											marginLeft: 6
										},
										children: t("pop.model")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SupervisorSelect, {
										control,
										models,
										t,
										onUse: (provider, model) => {
											post("supervise-use", {
												provider,
												model
											});
										}
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									lineHeight: "18px",
									color: COLOR.caption
								},
								children: !control.supervisor.enabled ? t("ctl.supOff") : control.loop.armed ? t("ctl.supOn") : t("ctl.supDep")
							})] }) : null
						]
					}),
					empty ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...cardStyle,
							padding: "18px 16px",
							color: COLOR.dim
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 16,
								fontWeight: 600,
								color: COLOR.text,
								marginBottom: 8
							},
							children: t("empty.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 14,
								lineHeight: "23px"
							},
							children: t("empty.body")
						})]
					}) : null,
					iterations.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...cardStyle,
							padding: "14px 10px 8px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexWrap: "wrap",
								gap: 8,
								alignItems: "center",
								padding: "0 6px",
								marginBottom: 10
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: chipStyle,
									title: t("tip.iters"),
									children: t("chips.iterations", { count: iterations.length - wrapUpChecks })
								}),
								wrapUpChecks > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										...chipStyle,
										color: COLOR.caption
									},
									title: t("tip.wrapup"),
									children: t("chips.wrapup", { count: wrapUpChecks })
								}) : null,
								best?.latencyMs !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										...chipStyle,
										color: COLOR.ok,
										borderColor: COLOR.ok,
										fontWeight: 500
									},
									children: [t("chips.best", { latency: formatLatency(best.latencyMs) }), best.speedup !== void 0 ? ` · ×${best.speedup.toPrecision(3)}` : ""]
								}) : null,
								series !== null && series.profileSeqs.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: chipStyle,
									children: t("chips.profiles", { count: series.profileSeqs.length })
								}) : null,
								hackCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										...chipStyle,
										color: COLOR.warn,
										borderColor: COLOR.warn
									},
									children: t("chips.hacks", { count: hackCount })
								}) : null,
								pendingCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										...chipStyle,
										color: COLOR.caption
									},
									children: t("chips.pending")
								}) : null
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chart, {
							series,
							bestLabel: t("axis.best"),
							statusLabel: (status) => t(`status.${status}`)
						})]
					}) : null,
					empty ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: cardStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									alignItems: "baseline",
									gap: 8,
									marginBottom: 8
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 14,
											fontWeight: 600
										},
										children: t("plan.title")
									}),
									latestPlan !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 12,
											color: COLOR.caption
										},
										children: t("plan.count", { n: plans.length })
									}) : null,
									plans.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 12,
											color: COLOR.curve,
											cursor: "pointer"
										},
										onClick: () => {
											setPlanHistory((value) => !value);
										},
										children: planHistory ? t("plan.hide") : t("plan.history", { n: plans.length - 1 })
									}) : null
								]
							}),
							latestPlan === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 14,
									color: COLOR.caption
								},
								children: t("plan.none")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 4
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 8
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												...chipStyle,
												color: COLOR.curve,
												borderColor: COLOR.curve,
												fontSize: 12,
												padding: "0 8px"
											},
											children: latestPlan.phase
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												fontSize: 14,
												fontWeight: 500
											},
											children: latestPlan.approach
										})]
									}),
									latestPlan.hypothesis !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 13,
											color: COLOR.dim
										},
										children: latestPlan.hypothesis
									}) : null,
									latestPlan.next !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											fontSize: 13,
											color: COLOR.dim
										},
										children: [
											t("plan.next"),
											" → ",
											latestPlan.next
										]
									}) : null
								]
							}),
							planHistory && plans.length > 1 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									marginTop: 10,
									paddingTop: 8,
									borderTop: `1px solid ${COLOR.border}`,
									display: "flex",
									flexDirection: "column",
									gap: 8
								},
								children: plans.slice(0, -1).reverse().map((plan, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										flexDirection: "column",
										gap: 2
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											alignItems: "center",
											gap: 8
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontSize: 12,
													color: COLOR.caption,
													minWidth: 62
												},
												children: t("plan.count", { n: plans.length - 1 - i })
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													...chipStyle,
													color: COLOR.caption,
													fontSize: 11,
													padding: "0 7px",
													lineHeight: "18px"
												},
												children: plan.phase
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													fontSize: 13,
													color: COLOR.dim
												},
												children: plan.approach
											})
										]
									}), plan.hypothesis !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										style: {
											fontSize: 12,
											color: COLOR.caption,
											paddingLeft: 70
										},
										children: plan.hypothesis
									}) : null]
								}, plan.seq))
							}) : null
						]
					}),
					reviewedRounds.length > 0 || earlierReviews > 0 || control?.supervisor.enabled === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: cardStyle,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 14,
									fontWeight: 600,
									marginBottom: 8
								},
								children: t("advice.title")
							}),
							reviewedRounds.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 13,
									color: COLOR.caption
								},
								children: t("advice.waiting")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									display: "flex",
									flexDirection: "column",
									gap: 2,
									maxHeight: 260,
									overflowY: "auto"
								},
								children: [...reviewedRounds].reverse().map((round, revIndex) => {
									const kind = reviewKind(round);
									const open = expandedReview === round.seq;
									const ordinal = reviewedRounds.length - revIndex;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: {
											display: "flex",
											gap: 8,
											fontSize: 13,
											lineHeight: "24px",
											cursor: "pointer"
										},
										title: t("advice.expandHint"),
										onClick: () => {
											setExpandedReview(open ? null : round.seq);
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													flex: "none",
													width: 12,
													color: COLOR.caption
												},
												children: open ? "▾" : "▸"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													flex: "none",
													minWidth: 56,
													color: COLOR.caption
												},
												children: kind === "audit" ? t("advice.audit") : kind === "challenge" ? t("advice.challenge") : kind === "wrapup" ? t("advice.wrapup") : t("advice.round", { n: ordinal })
											}),
											round.review === "ok" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: {
													flex: "none",
													color: COLOR.ok
												},
												children: ["✓ ", t("advice.ok")]
											}), round.reviewNote !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													color: COLOR.caption,
													whiteSpace: "nowrap",
													overflow: "hidden",
													textOverflow: "ellipsis"
												},
												children: round.reviewNote
											}) : null] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												style: {
													color: COLOR.dim,
													whiteSpace: "nowrap",
													overflow: "hidden",
													textOverflow: "ellipsis"
												},
												children: round.review
											})
										]
									}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReviewDetail, {
										round,
										rounds,
										iterations,
										t
									}) : null] }, round.seq);
								})
							}),
							earlierReviews > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								style: {
									fontSize: 12,
									color: COLOR.caption,
									marginTop: 6
								},
								children: t("advice.earlier", { n: earlierReviews })
							}) : null
						]
					}) : null,
					iterations.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...cardStyle,
							padding: 0,
							overflow: "hidden"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: "11px 16px",
								fontSize: 14,
								fontWeight: 600,
								borderBottom: `1px solid ${COLOR.border}`
							},
							children: t("table.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								maxHeight: 420,
								overflowY: "auto"
							},
							children: [...iterations].reverse().map((p) => {
								const status = statusOf(p);
								const idx = iterations.indexOf(p);
								const isBest = series !== null && series.bestIndex === idx;
								const expanded = expandedSeq === p.seq;
								const unverifiedFinal = p.finalized === true && p.channel === "shell" && !iterations.some((q) => q.channel === "replay" && q.artifactPath !== void 0 && p.artifactPath !== void 0 && samePath(q.artifactPath, p.artifactPath));
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 10,
										padding: "6px 16px",
										fontSize: 13,
										lineHeight: "22px",
										borderBottom: `1px solid ${COLOR.border}`,
										cursor: "pointer"
									},
									onClick: () => {
										setExpandedSeq(expanded ? null : p.seq);
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												width: 14,
												color: COLOR.caption
											},
											children: expanded ? "▾" : "▸"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: {
												flex: "none",
												width: 32,
												color: COLOR.caption
											},
											children: ["#", idx + 1]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												width: 58,
												color: COLOR.dim
											},
											children: p.evaluationId ?? "—"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												width: 92,
												color: COLOR.text,
												fontVariantNumeric: "tabular-nums"
											},
											children: p.latencyMs !== void 0 ? formatLatency(p.latencyMs) : "—"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												width: 70,
												fontVariantNumeric: "tabular-nums",
												fontWeight: isBest ? 600 : 400,
												color: isBest ? COLOR.ok : COLOR.dim
											},
											children: p.speedup !== void 0 ? `×${p.speedup.toPrecision(3)}` : ""
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
										inWrapUpPhase(rounds, p.seq) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											title: t("tip.wrapup"),
											style: {
												flex: "none",
												fontSize: 11,
												lineHeight: "16px",
												padding: "0 6px",
												borderRadius: 4,
												border: `1px solid ${COLOR.border}`,
												color: COLOR.caption
											},
											children: t("row.wrapup")
										}) : null,
										p.channel !== "shell" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											title: t(p.channel === "replay" ? "tip.replay" : "tip.tool"),
											style: {
												flex: "none",
												fontSize: 11,
												lineHeight: "16px",
												padding: "0 6px",
												borderRadius: 4,
												border: `1px solid ${COLOR.border}`,
												color: p.channel === "replay" ? COLOR.ok : COLOR.caption
											},
											children: t(p.channel === "replay" ? "row.channelReplay" : "row.channelTool")
										}) : null,
										isBest ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												color: COLOR.ok
											},
											title: t("tip.best"),
											children: "★"
										}) : null,
										p.finalized === true && p.channel !== "replay" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: {
												flex: "none",
												color: COLOR.curve
											},
											title: t("tip.final"),
											children: ["⚑ ", t("table.final")]
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												color: STATUS_COLOR[status],
												fontWeight: 500
											},
											title: status === "ok" ? t("tip.ok") : void 0,
											children: t(`status.${status}`)
										})
									]
								}), expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IterationDetail, {
									point: p,
									plans,
									rounds,
									t,
									unverifiedFinal
								}) : null] }, p.seq);
							})
						})]
					}) : null
				]
			});
		}
		/**
		* Composer tool-row loop launcher — the idle half of the chat-side loop
		* affordance. One trigger capsule in the tool row; clicking opens a
		* menu-styled popover carrying the full launch settings (budget, supervision
		* toggle, supervisor model), the arm button (gated until the session has a
		* human task, mirroring the Node-side gate), and a pointer to the
		* Evaluations tab for the live curve.
		*/
		function ChatLoopButton(props) {
			const { t } = props;
			const sessionId = props.session.sessionId;
			const { control, refetch } = useControl(sessionId);
			const models = useModels();
			const [open, setOpen] = (0, react.useState)(false);
			const [budgetDraft, setBudgetDraft] = (0, react.useState)(null);
			if (control === null || !control.loop.available || control.loop.armed) return null;
			const post = async (action, extra) => {
				try {
					await fetch(CONTROL_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							sessionId,
							action,
							...extra
						})
					});
				} catch {}
				refetch();
			};
			const budgetValue = budgetDraft ?? String(control.loop.budget > 0 ? control.loop.budget : control.loop.defaultBudget);
			const arm = async () => {
				const budget = Number(budgetValue);
				await post("loop-arm", Number.isInteger(budget) && budget > 0 ? { budget } : {});
				setOpen(false);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				style: {
					position: "relative",
					display: "inline-flex"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: buttonStyle(COLOR.curve),
					title: t("ctl.start"),
					onClick: () => {
						setOpen((value) => !value);
					},
					children: ["⟳ ", t("ctl.start")]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						position: "fixed",
						inset: 0,
						zIndex: 40
					},
					onClick: () => {
						setOpen(false);
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: popoverStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							style: popoverRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("pop.budget") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "number",
								min: 1,
								max: 9999,
								value: budgetValue,
								style: inputStyle,
								onChange: (event) => {
									setBudgetDraft(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: popoverRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("pop.supervise") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SuperviseToggle, {
								control,
								t,
								onToggle: () => {
									post(control.supervisor.enabled ? "supervise-off" : "supervise-on");
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								lineHeight: "18px",
								color: COLOR.caption
							},
							children: control.supervisor.enabled ? t("pop.supNote") : t("ctl.supOff")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: popoverRowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("pop.model") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SupervisorSelect, {
								control,
								models,
								t,
								onUse: (provider, model) => {
									post("supervise-use", {
										provider,
										model
									});
								},
								style: { maxWidth: 170 }
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							style: {
								...primaryBtnStyle,
								marginTop: 2
							},
							onClick: () => {
								arm();
							},
							children: ["⟳ ", t("ctl.start")]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								lineHeight: "18px",
								color: COLOR.caption
							},
							children: t("pop.footer")
						})
					]
				})] }) : null]
			});
		}
		/**
		* Above-composer strip — the armed half of the chat-side loop affordance:
		* round/budget state plus a stop button, so a running loop is visible and
		* stoppable without leaving the chat view. Renders nothing while disarmed,
		* so the idle composer stays untouched.
		*/
		function ChatLoopStrip(props) {
			const { t } = props;
			const sessionId = props.session.sessionId;
			const { control, refetch } = useControl(sessionId);
			if (control === null || !control.loop.armed) return null;
			const stop = async () => {
				try {
					await fetch(CONTROL_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							sessionId,
							action: "loop-stop"
						})
					});
				} catch {}
				refetch();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					boxSizing: "border-box",
					width: "calc(100% - var(--dsh-composer-side-clearance, 12px) * 2)",
					maxWidth: "var(--dsh-composer-card-max-width, 800px)",
					margin: "0 auto"
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 10,
						padding: "5px 12px",
						fontSize: 13,
						fontFamily: "system-ui",
						border: `1px solid ${COLOR.curve}`,
						borderRadius: 12,
						background: COLOR.tip,
						color: COLOR.text
					},
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							style: {
								color: COLOR.curve,
								fontWeight: 500
							},
							children: ["⟳ ", t("loop.armed", {
								round: control.loop.round,
								done: control.loop.evalsDone,
								budget: control.loop.budget
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							style: buttonStyle(COLOR.bad),
							onClick: () => {
								stop();
							},
							children: ["■ ", t("ctl.stop")]
						})
					]
				})
			});
		}
		/** Client-half service requirements. */
		const inject = [
			"slots",
			"locale",
			"sessions"
		];
		/** How often the watcher re-checks the current session for kernel-opt signals. */
		const DETECT_MS = 3e3;
		/** Whether a session has anything the evaluation tab could show. */
		function kernelOptRelevant(series) {
			return series.iterations.length > 0 || series.plans.length > 0 || series.control?.loop.armed === true;
		}
		/**
		* Mount the locale namespace and the session tab. The tab is NOT registered
		* unconditionally: a watcher follows the current session (`ctx.sessions.list`)
		* and holds the `conversation.view` registration only while that session
		* shows kernel-opt signals — evaluations, plans, or an armed loop. Unrelated
		* conversations never grow the tab; it appears by itself once the first
		* evaluation (or `/kloop`) lands, and the view ring follows registration
		* changes reactively (an active view that disappears falls back to the first
		* tab).
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "kernel-opt: dictionaries");
			ctx.slots.inject("conversation.view", () => {
				let hold;
				let disposed = false;
				let generation = 0;
				const show = () => {
					if (disposed || hold !== void 0) return;
					const holds = [
						ctx.slots.register({
							name: "conversation.view",
							id: "kernel-opt",
							order: 30,
							label: () => t("tab.label"),
							locale: NS
						}, KernelOptTab),
						ctx.slots.register({
							name: "conversation.input.left",
							id: "kernel-opt-loop",
							order: 50,
							locale: NS
						}, ChatLoopButton),
						ctx.slots.register({
							name: "conversation.input.dock",
							id: "kernel-opt-strip",
							order: 50,
							locale: NS
						}, ChatLoopStrip)
					];
					hold = () => {
						for (const dispose of holds) dispose();
					};
				};
				const hide = () => {
					hold?.();
					hold = void 0;
				};
				const sync = async () => {
					const gen = ++generation;
					const state = ctx.sessions.list.getSnapshot();
					const current = state.current;
					if (current === void 0) {
						hide();
						return;
					}
					if (state.byId[current]?.agentPreset === "kernel-opt") {
						show();
						return;
					}
					try {
						const res = await fetch(`${SERIES_PATH}?sessionId=${encodeURIComponent(current)}`, { headers: { accept: "application/json" } });
						if (gen !== generation || disposed) return;
						if (!res.ok) {
							hide();
							return;
						}
						const data = await res.json();
						if (gen !== generation || disposed) return;
						if (kernelOptRelevant(data)) show();
						else hide();
					} catch {}
				};
				const unsubscribe = ctx.sessions.list.subscribe(() => {
					sync();
				});
				const timer = setInterval(() => {
					sync();
				}, DETECT_MS);
				sync();
				return () => {
					disposed = true;
					clearInterval(timer);
					unsubscribe();
					hide();
				};
			});
		}
		//#endregion
		exports.ChatLoopButton = ChatLoopButton;
		exports.ChatLoopStrip = ChatLoopStrip;
		exports.KernelOptTab = KernelOptTab;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map