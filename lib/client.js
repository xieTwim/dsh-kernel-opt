window.__ModuleLoader__.load({
	id: "@xietwim/dsh-kernel-cockpit",
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
		/** Route the Node half serves and the panel polls (query: `?sessionId=`). */
		const SERIES_PATH = "/plugins/kernel-cockpit/series";
		/**
		* Control route (POST): `{ sessionId, action, budget?, provider?, model? }`
		* with action one of `loop-arm` / `loop-stop` / `supervise-on` /
		* `supervise-off` / `supervise-use` (both provider+model set the session
		* override; both empty resets to config). Responds with the fresh
		* {@link WireControl}. The slash commands remain the scriptable twin of the
		* same state.
		*/
		const CONTROL_PATH = "/plugins/kernel-cockpit/control";
		/** Models route (GET): the {@link WireModels} catalog for the picker. */
		const MODELS_PATH = "/plugins/kernel-cockpit/models";
		//#endregion
		//#region src/client/index.tsx
		/**
		* dsh-kernel-cockpit — browser half.
		*
		* 「算子优化」 session tab (`conversation.view` slot): polls the Node half's
		* series route and renders the live optimization picture — latency curve over
		* evaluations (log scale when the journey is wide), correctness/reward-hack
		* status per point, profiler ▲ and finalize ★ marks, the model's latest
		* `cockpit_plan`, and an iteration table. Pure projection of the session log;
		* a replayed session renders identically.
		* @module
		*/
		const NS = "kernel-cockpit";
		const zh = {
			"tab.label": "算子优化",
			"empty.title": "还没有评测数据",
			"empty.body": "当 agent 调用 kernel 评测工具(如 kernel_evaluate)后,这里会实时出现优化曲线;模型调用 cockpit_plan 后会展示当前方案。",
			"chips.iterations": "{count} 次评测",
			"chips.best": "最佳 {latency}",
			"chips.profiles": "{count} 次 profile",
			"chips.hacks": "{count} 次 reward-hack 拦截",
			"chips.pending": "评测中…",
			"plan.title": "当前方案",
			"plan.none": "模型尚未调用 cockpit_plan 汇报方案。",
			"plan.next": "下一步",
			"plan.count": "第 {n} 次汇报",
			"table.title": "迭代记录",
			"status.pending": "评测中",
			"status.ok": "通过",
			"status.wrong": "未通过",
			"status.hack": "reward-hack",
			"status.error": "失败",
			"axis.best": "最佳",
			"loop.armed": "循环中 · 第 {round} 轮 · {done}/{budget} 评测",
			"loop.stopped": "循环已停:{reason}",
			"loop.hint": "/kloop [预算] 启动循环 · /supervise on 开启第二模型监督",
			"sup.on": "监督 on",
			"sup.off": "监督 off",
			"sup.needCfg": "未配置监督模型:下拉选一个,或在插件 config 加 supervisor: { provider, model }",
			"sup.model": "监督模型",
			"sup.default": "跟随配置",
			"sup.pick": "选择监督模型…",
			"ctl.start": "启动循环",
			"ctl.stop": "停止循环",
			"ctl.budget": "评测预算",
			"advice.title": "监督记录",
			"advice.waiting": "监督已开启,将在下一个续跑点复审。",
			"advice.round": "第 {n} 轮",
			"reason.finalized": "已 finalize",
			"reason.budget": "预算用尽,已请求收尾",
			"reason.no-progress": "连续无进展,已请求收尾",
			"reason.stopped": "手动停止",
			"row.plan": "生效方案",
			"row.review": "该轮监督",
			"row.metrics": "指标",
			"row.error": "错误",
			"row.blocking": "阻断项",
			"row.advisory": "提示项",
			"row.notMeasured": "未测得",
			"row.subset": "工作负载子集",
			"row.evaluatorFailed": "评测器故障(不构成对 kernel 的判定)",
			"row.changes": "本轮改动",
			"row.write": "整文件写入",
			"row.edit": "替换",
			"row.truncated": "(已截断)",
			"row.channelShell": "自报",
			"row.channelReplay": "复测",
			"row.command": "来源命令",
			"row.unverifiedFinal": "最终数字未复测(自报值)",
			"table.final": "提交"
		};
		const en = {
			"tab.label": "Kernel Opt",
			"empty.title": "No evaluations yet",
			"empty.body": "Once the agent calls a kernel bench tool (e.g. kernel_evaluate) the optimization curve appears here live; cockpit_plan calls show the current plan.",
			"chips.iterations": "{count} evaluations",
			"chips.best": "best {latency}",
			"chips.profiles": "{count} profiles",
			"chips.hacks": "{count} reward-hacks caught",
			"chips.pending": "evaluating…",
			"plan.title": "Current plan",
			"plan.none": "The model has not reported a plan via cockpit_plan yet.",
			"plan.next": "Next",
			"plan.count": "report #{n}",
			"table.title": "Iterations",
			"status.pending": "running",
			"status.ok": "ok",
			"status.wrong": "wrong",
			"status.hack": "reward-hack",
			"status.error": "failed",
			"axis.best": "best",
			"loop.armed": "looping · round {round} · {done}/{budget} evals",
			"loop.stopped": "loop stopped: {reason}",
			"loop.hint": "/kloop [budget] arms the loop · /supervise on enables the second model",
			"sup.on": "supervisor on",
			"sup.off": "supervisor off",
			"sup.needCfg": "No supervisor model configured: pick one below, or add supervisor: { provider, model } to the plugin config",
			"sup.model": "Supervisor model",
			"sup.default": "follow config",
			"sup.pick": "pick a supervisor model…",
			"ctl.start": "Start loop",
			"ctl.stop": "Stop loop",
			"ctl.budget": "evaluation budget",
			"advice.title": "Supervision log",
			"advice.waiting": "Supervision on; it reviews at the next continuation point.",
			"advice.round": "round {n}",
			"reason.finalized": "finalized",
			"reason.budget": "budget exhausted, wrap-up requested",
			"reason.no-progress": "stalled, wrap-up requested",
			"reason.stopped": "stopped manually",
			"row.plan": "Plan in effect",
			"row.review": "Supervision",
			"row.metrics": "Metrics",
			"row.error": "Error",
			"row.blocking": "Blocking",
			"row.advisory": "Advisory",
			"row.notMeasured": "Not measured",
			"row.subset": "Workload subset",
			"row.evaluatorFailed": "Evaluator failed (not a verdict on the kernel)",
			"row.changes": "Changes this round",
			"row.write": "full write",
			"row.edit": "edit",
			"row.truncated": "(truncated)",
			"row.channelShell": "self-reported",
			"row.channelReplay": "replayed",
			"row.command": "Command",
			"row.unverifiedFinal": "final number not replayed (self-reported)",
			"table.final": "final"
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
			tip: "var(--dsw-specific-tip, rgba(77,107,254,.06))",
			curve: "var(--dsw-specific-primary, #4d6bfe)",
			ok: "#1f8f5f",
			bad: "#d93a3f",
			warn: "#d18a1f"
		};
		/** Session-scoped polling hook for the cockpit series (+ manual refetch). */
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
			const lo = min * .97;
			const log = lo > 0 && hi / lo > 20;
			const toAxis = (v) => log ? Math.log10(v) : v;
			const axLo = toAxis(lo);
			const span = toAxis(hi) - axLo || 1;
			const innerW = CHART.w - CHART.l - CHART.r;
			const innerH = CHART.h - CHART.t - CHART.b;
			const denom = Math.max(1, count - 1);
			return {
				x: (index) => CHART.l + innerW * index / denom,
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
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: CHART.l - 6,
						y: CHART.t + 4,
						textAnchor: "end",
						fontSize: 12,
						fill: COLOR.dim,
						children: formatLatency(model.hi)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: CHART.l - 6,
						y: CHART.h - CHART.b,
						textAnchor: "end",
						fontSize: 12,
						fill: COLOR.dim,
						children: formatLatency(model.lo)
					}),
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
						}), f === .5 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
							x: CHART.l - 6,
							y: gy + 4,
							textAnchor: "end",
							fontSize: 10,
							fill: COLOR.caption,
							children: formatLatency(value)
						}) : null] }, `g${String(f)}`);
					}),
					best?.latencyMs !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("line", {
						x1: CHART.l,
						x2: CHART.w - CHART.r,
						y1: model.y(best.latencyMs),
						y2: model.y(best.latencyMs),
						stroke: COLOR.ok,
						strokeWidth: 1,
						strokeDasharray: "4 4",
						opacity: .6
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("text", {
						x: CHART.w - CHART.r,
						y: model.y(best.latencyMs) - 4,
						textAnchor: "end",
						fontSize: 11,
						fill: COLOR.ok,
						children: [
							bestLabel,
							" ",
							formatLatency(best.latencyMs)
						]
					})] }) : null,
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
						const marks = `${bestIndex === i ? " ★" : ""}${p.finalized === true ? " ⚑" : ""}`;
						const tip = `#${String(i + 1)} · ${p.latencyMs !== void 0 ? formatLatency(p.latencyMs) : "—"} · ${statusLabel(status)}${marks}`;
						if (p.latencyMs === void 0) {
							const cy = CHART.h - CHART.b;
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
							p.finalized === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
								x: cx,
								y: cy - (isBest ? 21 : 8),
								textAnchor: "middle",
								fontSize: 12,
								fill: COLOR.warn,
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
			padding: "10px 14px"
		};
		/** Chip-shaped select for the supervisor model picker. */
		const selectStyle = {
			...chipStyle,
			cursor: "pointer",
			background: "transparent",
			fontFamily: "inherit",
			color: COLOR.dim,
			maxWidth: 240
		};
		/** Chip-shaped button; accent colors border + text. */
		function buttonStyle(accent) {
			return {
				...chipStyle,
				cursor: "pointer",
				background: "transparent",
				fontFamily: "inherit",
				...accent !== void 0 ? {
					color: accent,
					borderColor: accent
				} : {}
			};
		}
		const inputStyle = {
			...chipStyle,
			width: 72,
			background: "transparent",
			fontFamily: "inherit",
			outline: "none"
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
		/** The cockpit tab. */
		function CockpitTab(props) {
			const { t, sessionId } = props;
			const { series, refetch } = useSeries(sessionId);
			const models = useModels();
			const [budgetDraft, setBudgetDraft] = (0, react.useState)("20");
			const [expandedSeq, setExpandedSeq] = (0, react.useState)(null);
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
			const reviewedRounds = rounds.filter((r) => r.review !== void 0);
			const reasonLabel = (reason) => reason === "finalized" || reason === "budget" || reason === "no-progress" || reason === "stopped" ? t(`reason.${reason}`) : reason;
			if (iterations.length === 0 && plans.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: 24,
					maxWidth: 720,
					margin: "0 auto",
					fontFamily: "system-ui",
					color: COLOR.dim
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 16,
							fontWeight: 600,
							color: COLOR.text,
							marginBottom: 8
						},
						children: t("empty.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 14,
							lineHeight: "23px"
						},
						children: t("empty.body")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 13,
							lineHeight: "22px",
							marginTop: 10,
							color: COLOR.caption
						},
						children: t("loop.hint")
					})
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					padding: "16px 20px",
					maxWidth: 860,
					margin: "0 auto",
					display: "flex",
					flexDirection: "column",
					gap: 14,
					fontFamily: "system-ui",
					color: COLOR.text
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexWrap: "wrap",
							gap: 8,
							alignItems: "center"
						},
						children: [
							control?.loop.armed === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									...chipStyle,
									color: COLOR.curve,
									borderColor: COLOR.curve
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
							})] }) : null,
							control !== void 0 && control.loop.armed === false && control.loop.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								control.loop.stopReason !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: chipStyle,
									children: t("loop.stopped", { reason: reasonLabel(control.loop.stopReason) })
								}) : null,
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 1,
									max: 9999,
									value: budgetDraft,
									title: t("ctl.budget"),
									style: inputStyle,
									onChange: (event) => {
										setBudgetDraft(event.target.value);
									}
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									style: buttonStyle(COLOR.curve),
									onClick: () => {
										const budget = Number(budgetDraft);
										post("loop-arm", Number.isInteger(budget) && budget > 0 ? { budget } : {});
									},
									children: ["⟳ ", t("ctl.start")]
								})
							] }) : null,
							control !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [control.supervisor.configured ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle(control.supervisor.enabled ? COLOR.warn : void 0),
								title: control.supervisor.effective !== void 0 ? `${control.supervisor.effective.provider}/${control.supervisor.effective.model} (${control.supervisor.effective.source})` : void 0,
								onClick: () => {
									post(control.supervisor.enabled ? "supervise-off" : "supervise-on");
								},
								children: t(control.supervisor.enabled ? "sup.on" : "sup.off")
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									...chipStyle,
									color: COLOR.caption
								},
								title: t("sup.needCfg"),
								children: t("sup.off")
							}), models !== null && models.providers.length > 0 ? (() => {
								const effective = control.supervisor.effective;
								const overrideValue = effective !== void 0 && effective.source === "session" ? `${effective.provider}/${effective.model}` : "";
								const known = models.providers.flatMap((p) => p.models.map((m) => `${p.id}/${m.id}`));
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
									value: overrideValue,
									title: t("sup.model"),
									style: selectStyle,
									onChange: (event) => {
										const value = event.target.value;
										if (value === "") {
											post("supervise-use", {
												provider: "",
												model: ""
											});
											return;
										}
										const slash = value.indexOf("/");
										post("supervise-use", {
											provider: value.slice(0, slash),
											model: value.slice(slash + 1)
										});
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "",
											children: t("sup.default")
										}),
										overrideValue !== "" && !known.includes(overrideValue) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: overrideValue,
											children: overrideValue
										}) : null,
										models.providers.map((provider) => provider.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: `${provider.id}/${model.id}`,
											children: `${provider.id}/${model.id}`
										}, `${provider.id}/${model.id}`)))
									]
								});
							})() : null] }) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: chipStyle,
								children: t("chips.iterations", { count: iterations.length })
							}),
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
					}),
					iterations.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: cardStyle,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chart, {
							series,
							bestLabel: t("axis.best"),
							statusLabel: (status) => t(`status.${status}`)
						})
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: cardStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "baseline",
								gap: 8,
								marginBottom: 6
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 14,
									fontWeight: 600
								},
								children: t("plan.title")
							}), latestPlan !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 12,
									color: COLOR.caption
								},
								children: t("plan.count", { n: plans.length })
							}) : null]
						}), latestPlan === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
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
						})]
					}),
					reviewedRounds.length > 0 || control?.supervisor.enabled === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...cardStyle,
							borderColor: COLOR.warn
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 14,
								fontWeight: 600,
								marginBottom: 6,
								color: COLOR.warn
							},
							children: t("advice.title")
						}), reviewedRounds.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 13,
								color: COLOR.caption
							},
							children: t("advice.waiting")
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								display: "flex",
								flexDirection: "column",
								gap: 6,
								maxHeight: 200,
								overflowY: "auto"
							},
							children: [...reviewedRounds].reverse().map((round) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 10,
									fontSize: 13,
									lineHeight: "20px"
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										flex: "none",
										minWidth: 56,
										color: COLOR.caption
									},
									children: t("advice.round", { n: round.round ?? "—" })
								}), round.review === "ok" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { color: COLOR.ok },
									children: "✓ OK"
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										color: COLOR.dim,
										whiteSpace: "pre-wrap"
									},
									children: round.review
								})]
							}, round.seq))
						})]
					}) : null,
					iterations.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...cardStyle,
							padding: 0,
							overflow: "hidden"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								padding: "8px 14px",
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
										padding: "5px 14px",
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
										p.channel !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												fontSize: 11,
												lineHeight: "16px",
												padding: "0 6px",
												borderRadius: 4,
												border: `1px solid ${COLOR.border}`,
												color: p.channel === "replay" ? COLOR.ok : COLOR.caption
											},
											children: t(p.channel === "replay" ? "row.channelReplay" : "row.channelShell")
										}) : null,
										isBest ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												color: COLOR.ok
											},
											children: "★"
										}) : null,
										p.finalized === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: {
												flex: "none",
												color: COLOR.warn
											},
											children: ["⚑ ", t("table.final")]
										}) : null,
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												color: STATUS_COLOR[status],
												fontWeight: 500
											},
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
		/** Client-half service requirements. */
		const inject = [
			"slots",
			"locale",
			"sessions"
		];
		/** How often the watcher re-checks the current session for cockpit signals. */
		const DETECT_MS = 3e3;
		/** Whether a session has anything the cockpit tab could show. */
		function cockpitRelevant(series) {
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
			}), "kernel-cockpit: dictionaries");
			ctx.slots.inject("conversation.view", () => {
				let hold;
				let disposed = false;
				let generation = 0;
				const show = () => {
					if (disposed || hold !== void 0) return;
					hold = ctx.slots.register({
						name: "conversation.view",
						id: "kernel-cockpit",
						order: 30,
						label: () => t("tab.label"),
						locale: NS
					}, CockpitTab);
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
						if (cockpitRelevant(data)) show();
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
		exports.CockpitTab = CockpitTab;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map