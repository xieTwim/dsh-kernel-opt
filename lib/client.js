window.__ModuleLoader__.load({
	id: "@xsyshuishui/dsh-kernel-cockpit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/wire.ts
		/** Route the Node half serves and the panel polls (query: `?sessionId=`). */
		const SERIES_PATH = "/plugins/kernel-cockpit/series";
		//#endregion
		//#region src/client/index.tsx
		/**
		* dsh-kernel-cockpit — browser half.
		*
		* "优化驾驶舱" session tab (`conversation.view` slot): polls the Node half's
		* series route and renders the live optimization picture — latency curve over
		* evaluations (log scale when the journey is wide), correctness/reward-hack
		* status per point, profiler ▲ and finalize ★ marks, the model's latest
		* `cockpit_plan`, and an iteration table. Pure projection of the session log;
		* a replayed session renders identically.
		* @module
		*/
		const NS = "kernel-cockpit";
		const zh = {
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
			"loop.stopped": "循环已停({reason})",
			"loop.hint": "/kloop [预算] 启动循环 · /supervise on 开启第二模型监督",
			"sup.on": "监督 on",
			"sup.off": "监督 off",
			"advice.title": "监督建议",
			"table.final": "提交"
		};
		const en = {
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
			"loop.stopped": "loop stopped ({reason})",
			"loop.hint": "/kloop [budget] arms the loop · /supervise on enables the second model",
			"sup.on": "supervisor on",
			"sup.off": "supervisor off",
			"advice.title": "Supervisor advice",
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
		/** Session-scoped polling hook for the cockpit series. */
		function useSeries(sessionId) {
			const [series, setSeries] = (0, react.useState)(null);
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
			}, [sessionId]);
			return series;
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
		/** Build the y mapping from the measured latencies (log when the span is wide). */
		function chartModel(measured, count) {
			const lats = measured.map((p) => p.latencyMs).filter((v) => v !== void 0);
			if (lats.length === 0) return null;
			const min = Math.min(...lats);
			const max = Math.max(...lats);
			const log = min > 0 && max / min > 20;
			const lo = log ? Math.log10(min) : min;
			const span = (log ? Math.log10(max) : max) - lo || 1;
			const innerW = CHART.w - CHART.l - CHART.r;
			const innerH = CHART.h - CHART.t - CHART.b;
			const denom = Math.max(1, count - 1);
			return {
				x: (index) => CHART.l + innerW * index / denom,
				y: (latencyMs) => {
					const v = log ? Math.log10(latencyMs) : latencyMs;
					return CHART.t + innerH * (1 - (v - lo) / span);
				},
				log,
				min,
				max
			};
		}
		/** Latency curve with per-point status, best line, profile ▲ and finalize ★. */
		function Chart(props) {
			const { series, bestLabel } = props;
			const { iterations, profileSeqs, bestIndex } = series;
			const model = (0, react.useMemo)(() => chartModel(iterations, iterations.length), [iterations]);
			if (model === null) return null;
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
						fontSize: 11,
						fill: COLOR.dim,
						children: formatLatency(model.max)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: CHART.l - 6,
						y: CHART.h - CHART.b,
						textAnchor: "end",
						fontSize: 11,
						fill: COLOR.dim,
						children: formatLatency(model.min)
					}),
					model.log ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x: CHART.l - 6,
						y: (CHART.t + CHART.h - CHART.b) / 2,
						textAnchor: "end",
						fontSize: 10,
						fill: COLOR.caption,
						children: "log"
					}) : null,
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
						fontSize: 10,
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
						if (p.latencyMs === void 0) {
							const cy = CHART.h - CHART.b;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("g", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
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
							}) }, p.seq);
						}
						const cy = model.y(p.latencyMs);
						const isBest = bestIndex === i;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("g", { children: [
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
							isBest ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
								x: cx,
								y: cy - 8,
								textAnchor: "middle",
								fontSize: 12,
								fill: COLOR.ok,
								children: "★"
							}) : null,
							p.finalized === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
								x: cx,
								y: cy - (isBest ? 20 : 8),
								textAnchor: "middle",
								fontSize: 11,
								fill: COLOR.warn,
								children: "⚑"
							}) : null
						] }, p.seq);
					}),
					profileXs.map((x, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("text", {
						x,
						y: CHART.h - CHART.b + 12,
						textAnchor: "middle",
						fontSize: 9,
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
			fontSize: 12,
			lineHeight: "20px",
			color: COLOR.dim,
			whiteSpace: "nowrap"
		};
		const cardStyle = {
			border: `1px solid ${COLOR.border}`,
			borderRadius: 12,
			background: COLOR.tip,
			padding: "10px 14px"
		};
		/** The cockpit tab. */
		function CockpitTab(props) {
			const { t, sessionId } = props;
			const series = useSeries(sessionId);
			const iterations = series?.iterations ?? [];
			const plans = series?.plans ?? [];
			const latestPlan = plans.length > 0 ? plans[plans.length - 1] : void 0;
			const best = series !== null && series.bestIndex !== null ? iterations[series.bestIndex] : void 0;
			const hackCount = iterations.filter((p) => p.rewardHack === true).length;
			const pendingCount = iterations.filter((p) => p.pending === true).length;
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
							fontSize: 15,
							fontWeight: 600,
							color: COLOR.text,
							marginBottom: 8
						},
						children: t("empty.title")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 13,
							lineHeight: "22px"
						},
						children: t("empty.body")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: 12,
							lineHeight: "20px",
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
							gap: 8
						},
						children: [
							series?.control?.loop.armed === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: {
									...chipStyle,
									color: COLOR.curve,
									borderColor: COLOR.curve
								},
								children: ["⟳ ", t("loop.armed", {
									round: series.control.loop.round,
									done: series.control.loop.evalsDone,
									budget: series.control.loop.budget
								})]
							}) : series?.control?.loop.stopReason !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: chipStyle,
								children: t("loop.stopped", { reason: series.control.loop.stopReason })
							}) : null,
							series?.control !== void 0 && (series.control.supervisor.enabled || series.control.supervisor.configured) ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									...chipStyle,
									...series.control.supervisor.enabled ? {
										color: COLOR.warn,
										borderColor: COLOR.warn
									} : {}
								},
								children: t(series.control.supervisor.enabled ? "sup.on" : "sup.off")
							}) : null,
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
							bestLabel: t("axis.best")
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
									fontSize: 13,
									fontWeight: 600
								},
								children: t("plan.title")
							}), latestPlan !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									fontSize: 11,
									color: COLOR.caption
								},
								children: t("plan.count", { n: plans.length })
							}) : null]
						}), latestPlan === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 13,
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
											fontSize: 11,
											padding: "0 8px"
										},
										children: latestPlan.phase
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: {
											fontSize: 13,
											fontWeight: 500
										},
										children: latestPlan.approach
									})]
								}),
								latestPlan.hypothesis !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										fontSize: 12,
										color: COLOR.dim
									},
									children: latestPlan.hypothesis
								}) : null,
								latestPlan.next !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										fontSize: 12,
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
					series?.control?.supervisor.lastAdvice !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							...cardStyle,
							borderColor: COLOR.warn
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 13,
								fontWeight: 600,
								marginBottom: 4,
								color: COLOR.warn
							},
							children: t("advice.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								fontSize: 12,
								lineHeight: "20px",
								color: COLOR.dim,
								whiteSpace: "pre-wrap"
							},
							children: series.control.supervisor.lastAdvice
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
								fontSize: 13,
								fontWeight: 600,
								borderBottom: `1px solid ${COLOR.border}`
							},
							children: t("table.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: {
								maxHeight: 260,
								overflowY: "auto"
							},
							children: [...iterations].reverse().map((p) => {
								const status = statusOf(p);
								const idx = iterations.indexOf(p);
								const isBest = series !== null && series.bestIndex === idx;
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										display: "flex",
										alignItems: "center",
										gap: 10,
										padding: "4px 14px",
										fontSize: 12,
										lineHeight: "20px",
										borderBottom: `1px solid ${COLOR.border}`
									},
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											style: {
												flex: "none",
												width: 28,
												color: COLOR.caption
											},
											children: ["#", idx + 1]
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												width: 52,
												color: COLOR.dim
											},
											children: p.evaluationId ?? "—"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												width: 86,
												color: COLOR.text,
												fontVariantNumeric: "tabular-nums"
											},
											children: p.latencyMs !== void 0 ? formatLatency(p.latencyMs) : "—"
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: {
												flex: "none",
												width: 64,
												fontVariantNumeric: "tabular-nums",
												fontWeight: isBest ? 600 : 400,
												color: isBest ? COLOR.ok : COLOR.dim
											},
											children: p.speedup !== void 0 ? `×${p.speedup.toPrecision(3)}` : ""
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
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
								}, p.seq);
							})
						})]
					}) : null
				]
			});
		}
		/** Client-half service requirements. */
		const inject = ["slots", "locale"];
		/** Mount the locale namespace and the session tab. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "kernel-cockpit: dictionaries");
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "kernel-cockpit",
				order: 30,
				label: "优化看板",
				locale: NS
			}, CockpitTab));
		}
		//#endregion
		exports.CockpitTab = CockpitTab;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map