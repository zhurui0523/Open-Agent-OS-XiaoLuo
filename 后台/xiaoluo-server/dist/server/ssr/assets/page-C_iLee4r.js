import { n as require_jsx_runtime, o as require_react, s as __toESM } from "../index.js";
//#region app/share/[token]/page.tsx
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var import_jsx_runtime = require_jsx_runtime();
function SharedCanvasPage({ params }) {
	const { token } = (0, import_react.use)(params);
	const [graph, setGraph] = (0, import_react.useState)(null);
	const [mode, setMode] = (0, import_react.useState)("");
	const [error, setError] = (0, import_react.useState)("");
	(0, import_react.useEffect)(() => {
		fetch(`/api/v2/canvases/share?token=${encodeURIComponent(token)}`).then(async (response) => {
			const payload = await response.json();
			if (!response.ok || !payload.share) throw new Error(payload.error ?? "分享读取失败");
			setMode(payload.share.mode);
			setGraph(payload.share.graph);
		}).catch((cause) => setError(cause instanceof Error ? cause.message : "分享读取失败"));
	}, [token]);
	if (error) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("main", {
		className: "shared-canvas-error",
		children: error
	});
	if (!graph) return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("main", {
		className: "shared-canvas-loading",
		children: "正在读取画布快照…"
	});
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("main", {
		className: "shared-canvas-page",
		children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { children: ["小逻Agent OS · ", mode === "workflow" ? "Workflow 模板" : "只读画布"] }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h1", { children: graph.title }),
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { children: [
				graph.projectName,
				" · revision ",
				graph.revision
			] })
		] }), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", {
			className: "shared-edge-layer",
			"aria-hidden": "true",
			children: graph.edges.map((edge) => {
				const source = graph.nodes.find((node) => node.id === edge.source);
				const target = graph.nodes.find((node) => node.id === edge.target);
				if (!source || !target) return null;
				const startX = source.x + 264;
				const startY = source.y + 64;
				const endX = target.x;
				const endY = target.y + 64;
				const control = Math.max(72, Math.abs(endX - startX) * .42);
				return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: `M ${startX} ${startY} C ${startX + control} ${startY}, ${endX - control} ${endY}, ${endX} ${endY}` }, edge.id);
			})
		}), graph.nodes.map((node) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("article", {
			className: `shared-node kind-${node.kind}`,
			style: {
				left: node.x,
				top: node.y
			},
			children: [
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: node.kind }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: node.title }),
				/* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: node.prompt }),
				node.result && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { children: node.result })
			]
		}, node.id))] })]
	});
}
//#endregion
export { SharedCanvasPage as default };
