/// <reference lib="dom" />
// The order graph (view B): wave columns, a d3 force layout, hover/tap to highlight neighbours.
import type { Edge, EdgeType, GraphJson, RunSummary } from '../src/contract.ts';
import { columnX, type Filters, fitBox, projectColor, startGroups, visible } from './logic.ts';

// document.currentScript is null once the script has yielded, so read it before any await.
const SELF = document.currentScript instanceof HTMLScriptElement ? document.currentScript : null;
const DATA_URL = SELF?.dataset.graph ?? '';

const D3_URL = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';
const D3_INTEGRITY = 'sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i';
const REFRESH_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const HEIGHT = 520;
const MIN_WIDTH = 640;

const CSS = `
#graph{--bg:#fff;--bg2:#f6f7f9;--fg:#1f2328;--fg2:#57606a;--fg3:#8c959f;--line:#d0d7de;--warn:#d93025;--blocks:#e8833a;
 color-scheme:light dark;font:14px system-ui,sans-serif;color:var(--fg);background:var(--bg);box-sizing:border-box;max-width:100%;overflow-x:hidden}
@media (prefers-color-scheme:dark){#graph{--bg:#14171a;--bg2:#1c2024;--fg:#e6e8ea;--fg2:#a7adb3;--fg3:#7d848b;--line:#363c42}}
#graph *{box-sizing:border-box}
#graph .bar{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--line)}
#graph .bar b{font-weight:600}
#graph .bar span{color:var(--fg2)}
#graph .bar select,#graph .bar button{font:inherit;color:var(--fg);background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:3px 6px;max-width:100%}
#graph .bar label{display:flex;gap:4px;align-items:center;color:var(--fg2)}
#graph .offline{display:none;margin:8px 10px 0;padding:6px 10px;border-radius:6px;background:#fff4e5;color:#7a4300;border:1px solid #f0b866}
#graph .offline.on{display:block}
#graph .stage{position:relative;margin:8px 10px;border:1px solid var(--line);border-radius:10px;background:var(--bg2);overflow:hidden;height:min(70vh,640px);min-height:360px}
#graph .stage svg{display:block;width:100%;height:100%;cursor:grab;touch-action:none}
#graph .stage .msg{padding:16px;color:var(--fg2)}
#graph .tip{position:absolute;left:10px;right:10px;bottom:8px;min-height:1.2em;pointer-events:none;color:var(--fg)}
#graph .lnk{stroke:var(--fg3);stroke-opacity:.5;stroke-width:1;fill:none}
#graph .lnk.relates{stroke-dasharray:4 3}
#graph .lnk.parent{stroke-dasharray:2 3}
#graph .lnk.blocks{stroke:var(--blocks);stroke-opacity:.95;stroke-width:1.8}
#graph .nd{stroke:var(--bg2);stroke-width:1.5;cursor:pointer}
#graph .nd.closed{fill-opacity:.35}
#graph .nd.cycle{stroke:var(--warn);stroke-width:3}
#graph .lbl{font:11px system-ui,sans-serif;fill:var(--fg2);pointer-events:none;paint-order:stroke;stroke:var(--bg2);stroke-width:3px}
#graph .col{font:600 11px system-ui,sans-serif;fill:var(--fg3);letter-spacing:.04em}
#graph .colline{stroke:var(--line);stroke-dasharray:3 5}
#graph .dim{opacity:.12}
#graph .panels{padding:0 10px 12px;display:grid;gap:8px}
#graph .cycles{padding:8px 10px;border-radius:6px;background:#fdecea;color:#8c1d18;border:1px solid #f1aeb5}
#graph .cycles div+div{margin-top:2px}
#graph h3{margin:6px 0 4px;font-size:14px}
#graph .grp{margin:4px 0}
#graph .grp .area{font-weight:600}
#graph .grp .par{color:var(--warn);margin-left:6px}
#graph .grp ul{margin:2px 0 0;padding-left:18px}
#graph a{color:inherit}
#graph .more{color:var(--fg2)}
`;

type Item = GraphJson['items'][number];
type Node = D3Node & { item: Item; r: number; color: string };
type Link = D3Link<Node> & { type: EdgeType };

let data: GraphJson | null = null;
let dataKey = '';
let loadSeq = 0;
let d3State: 'loading' | 'ready' | 'failed' = 'loading';
const filters: Filters = { showClosed: false, project: null, area: null };
let simulation: D3Simulation<Node> | null = null;
let fit: () => void = () => {};
/** The view the user set by zoom or pan; kept across data refreshes, dropped when the filters change. */
let userView: { x: number; y: number; k: number } | null = null;

const root = document.getElementById('graph');
const barEl = document.createElement('div');
const offlineEl = document.createElement('div');
const stageEl = document.createElement('div');
const panelsEl = document.createElement('div');

const two = (n: number) => String(n).padStart(2, '0');
/** Local HH:MM:SS, or HH:MM; an unreadable timestamp becomes a dash. */
function clock(iso: string | null, seconds: boolean): string {
	const d = new Date(iso ?? '');
	if (Number.isNaN(d.getTime())) return '—';
	const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
	return seconds ? `${hm}:${two(d.getSeconds())}` : hm;
}
const dataTime = (g: GraphJson) => clock(g.syncedAt ?? g.generatedAt, true);

function agentText(run: RunSummary | null): string {
	if (run === null) return 'агент ещё не работал';
	return `агент: ${clock(run.at, false)}, +${run.relationsAdded} связей, +${run.labelsAdded} меток`;
}

const isHttp = (url: string) => /^https?:\/\//i.test(url);
function openItem(item: Item): void {
	if (isHttp(item.url)) window.open(item.url, '_blank', 'noopener');
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text?: string,
	className?: string,
): HTMLElementTagNameMap[K] {
	const e = document.createElement(tag);
	if (text !== undefined) e.textContent = text;
	if (className !== undefined) e.className = className;
	return e;
}

/** Parses the response at the boundary: anything that is not a graph throws. */
function parseGraph(raw: unknown): GraphJson {
	const g = raw as Partial<GraphJson> | null;
	if (
		typeof g !== 'object' ||
		g === null ||
		!Array.isArray(g.items) ||
		!Array.isArray(g.edges) ||
		!Array.isArray(g.projects) ||
		!Array.isArray(g.cycles) ||
		!Array.isArray(g.conflicts) ||
		!Array.isArray(g.canStart) ||
		typeof g.generatedAt !== 'string'
	)
		throw new Error('not a graph');
	return g as GraphJson;
}

function loadD3(): Promise<void> {
	return new Promise((resolve, reject) => {
		if (typeof d3 !== 'undefined') {
			resolve();
			return;
		}
		const s = document.createElement('script');
		s.src = D3_URL;
		s.integrity = D3_INTEGRITY;
		s.crossOrigin = 'anonymous';
		s.onload = () => resolve();
		s.onerror = () => reject(new Error('d3 did not load'));
		document.head.append(s);
	});
}

function select(
	label: string,
	options: { value: string; text: string }[],
	current: string | null,
	onChange: (v: string | null) => void,
): HTMLSelectElement {
	const s = el('select');
	s.setAttribute('aria-label', label);
	s.append(new Option(label, ''));
	for (const o of options) s.append(new Option(o.text, o.value));
	s.value = current ?? '';
	s.onchange = () => onChange(s.value === '' ? null : s.value);
	return s;
}

function renderBar(): void {
	barEl.replaceChildren();
	if (data === null) return;
	const g = data;
	barEl.append(el('b', 'Граф задач'), el('span', `данные на ${dataTime(g)}`));
	barEl.append(el('span', agentText(g.lastAgentRun)));
	const areas = [...new Set(g.items.flatMap((i) => i.areas))].sort();
	if (filters.project !== null && !g.projects.some((p) => p.id === filters.project))
		filters.project = null;
	if (filters.area !== null && !areas.includes(filters.area)) filters.area = null;
	barEl.append(
		select(
			'Все проекты',
			g.projects.map((p) => ({ value: p.id, text: `${p.identifier} · ${p.name}` })),
			filters.project,
			(v) => {
				filters.project = v;
				userView = null;
				refresh();
			},
		),
		select(
			'Все области',
			areas.map((a) => ({ value: a, text: a })),
			filters.area,
			(v) => {
				filters.area = v;
				userView = null;
				refresh();
			},
		),
	);
	const label = el('label');
	const box = el('input');
	box.type = 'checkbox';
	box.checked = filters.showClosed;
	box.onchange = () => {
		filters.showClosed = box.checked;
		userView = null;
		refresh();
	};
	label.append(box, 'Показать закрытые');
	const fitBtn = el('button', 'Вписать');
	fitBtn.type = 'button';
	fitBtn.onclick = () => {
		userView = null;
		fit();
	};
	barEl.append(label, fitBtn);
}

function renderPanels(): void {
	panelsEl.replaceChildren();
	if (data === null) return;
	const g = data;
	const shown = visible(g, filters);
	const ids = new Set(shown.items.map((i) => i.id));
	const byId = new Map(g.items.map((i) => [i.id, i]));
	const keyOf = (id: string) => byId.get(id)?.key ?? id;

	if (g.cycles.length > 0) {
		const box = el('div', undefined, 'cycles');
		box.append(el('div', 'Цикл в «блокирует», порядок не определён:'));
		for (const cycle of g.cycles) box.append(el('div', cycle.map(keyOf).join(', ')));
		panelsEl.append(box);
	}

	const groups = startGroups(g.canStart, ids);
	if (groups.length > 0) {
		const box = el('div');
		box.append(el('h3', 'Можно сейчас'));
		for (const grp of groups) {
			const row = el('div', undefined, 'grp');
			const head = el('div');
			head.append(el('span', grp.area ?? 'без области', 'area'));
			if (grp.notParallel) head.append(el('span', 'не параллельно', 'par'));
			const list = el('ul');
			for (const id of grp.items) {
				const item = byId.get(id);
				if (item === undefined) continue;
				const li = el('li');
				const a = el('a', item.key);
				if (isHttp(item.url)) {
					a.href = item.url;
					a.target = '_blank';
					a.rel = 'noopener';
				}
				li.append(a, ` ${item.name}`);
				list.append(li);
			}
			row.append(head, list);
			box.append(row);
		}
		panelsEl.append(box);
	}

	if (g.hiddenOpen > 0)
		panelsEl.append(el('div', `ещё ${g.hiddenOpen} открытых задач без связей`, 'more'));
}

function renderOffline(failed: boolean): void {
	offlineEl.classList.toggle('on', failed);
	if (!failed) return;
	offlineEl.textContent =
		data === null
			? 'Нет связи с plane-graph'
			: `Нет связи с plane-graph, данные на ${dataTime(data)}`;
}

function drawGraph(): void {
	simulation?.stop();
	simulation = null;
	fit = () => {};
	stageEl.replaceChildren();
	if (d3State === 'failed') {
		stageEl.append(el('div', 'Не загрузилась библиотека графа (cdnjs)', 'msg'));
		return;
	}
	if (data === null || d3State !== 'ready') return;
	const g = data;
	const shown = visible(g, filters);
	if (shown.items.length === 0) {
		stageEl.append(el('div', 'Нет задач под выбранные фильтры', 'msg'));
		return;
	}

	const W = Math.max(stageEl.clientWidth, MIN_WIDTH);
	const H = HEIGHT;
	const degree = new Map<string, number>();
	for (const e of shown.edges)
		for (const id of [e.from, e.to]) degree.set(id, (degree.get(id) ?? 0) + 1);
	const projectIndex = new Map(g.projects.map((p, i) => [p.id, i]));
	const inCycle = new Set(g.cycles.flat());
	const conflicted = new Set(g.conflicts.flatMap((c) => c.items));
	const maxWave = Math.max(0, ...shown.items.map((i) => i.wave ?? 0));

	const nodes: Node[] = shown.items.map((item) => ({
		id: item.id,
		item,
		r: 4 + Math.sqrt(degree.get(item.id) ?? 0) * 2.6,
		color: projectColor(projectIndex.get(item.projectId) ?? 0),
	}));
	const links: Link[] = shown.edges.map((e: Edge) => ({
		source: e.from,
		target: e.to,
		type: e.type,
	}));
	const neighbours = new Map(nodes.map((n) => [n.id, new Set([n.id])]));
	for (const e of shown.edges) {
		neighbours.get(e.from)?.add(e.to);
		neighbours.get(e.to)?.add(e.from);
	}
	const labelled = (n: Node) =>
		n.item.wave !== null || inCycle.has(n.id) || conflicted.has(n.id) || n.item.inCycle;
	const labelText = (n: Node) => (conflicted.has(n.id) ? `${n.item.key} ⚠` : n.item.key);

	const svg = d3.select(stageEl).append('svg').attr('viewBox', `0 0 ${W} ${H}`);
	svg
		.append('defs')
		.append('marker')
		.attr('id', 'pg-arrow')
		.attr('viewBox', '0 0 10 10')
		.attr('refX', 10)
		.attr('refY', 5)
		.attr('markerWidth', 7)
		.attr('markerHeight', 7)
		.attr('orient', 'auto')
		.append('path')
		.attr('d', 'M0,1L10,5L0,9z')
		.attr('fill', '#e8833a');
	const layer = svg.append('g');
	const zoom = d3
		.zoom()
		.scaleExtent([0.3, 4])
		.on('zoom', (e) => {
			// A zoom with a source event comes from the user; fit() and the restore below have none.
			if (e.sourceEvent !== null) {
				autoFit = false;
				userView = { x: e.transform.x, y: e.transform.y, k: e.transform.k };
			}
			layer.attr(
				'transform',
				`translate(${e.transform.x},${e.transform.y}) scale(${e.transform.k})`,
			);
		});
	svg.call(zoom);
	// Fit once per drawing, and not at all when the user has already set a view.
	let autoFit = userView === null;
	if (userView !== null)
		svg.call(zoom.transform, d3.zoomIdentity.translate(userView.x, userView.y).scale(userView.k));

	for (let r = 0; r <= maxWave; r++) {
		const x = columnX(r, maxWave, W) as number;
		layer
			.append('line')
			.attr('class', 'colline')
			.attr('x1', x)
			.attr('x2', x)
			.attr('y1', 24)
			.attr('y2', H - 40);
		layer
			.append('text')
			.attr('class', 'col')
			.attr('x', x)
			.attr('y', 16)
			.attr('text-anchor', 'middle')
			.text(r === 0 ? 'МОЖНО СЕЙЧАС' : `ВОЛНА ${r + 1}`);
	}

	const linkSel = layer
		.append('g')
		.selectAll('line')
		.data(links)
		.join('line')
		.attr('class', (l) => `lnk ${l.type}`)
		.attr('marker-end', (l) => (l.type === 'blocks' ? 'url(#pg-arrow)' : null));
	const nodeSel = layer
		.append('g')
		.selectAll('circle')
		.data(nodes)
		.join('circle')
		.attr(
			'class',
			(n) =>
				`nd${n.item.closed ? ' closed' : ''}${inCycle.has(n.id) || n.item.inCycle ? ' cycle' : ''}`,
		)
		.attr('r', (n) => n.r)
		.attr('fill', (n) => n.color);
	const labelSel = layer
		.append('g')
		.selectAll('text')
		.data(nodes)
		.join('text')
		.attr('class', 'lbl')
		.attr('text-anchor', 'middle')
		.attr('dy', (n) => -n.r - 4)
		.text(labelText)
		.style('display', (n) => (labelled(n) ? null : 'none'));
	const tip = el('div', undefined, 'tip');
	stageEl.append(tip);

	let focused: string | null = null;
	let pointer = 'mouse';
	function focus(id: string | null): void {
		focused = id;
		const keep = id === null ? null : neighbours.get(id);
		nodeSel.classed('dim', (n) => keep?.has(n.id) === false);
		linkSel.classed('dim', (l) => id !== null && ref(l.source) !== id && ref(l.target) !== id);
		labelSel
			.classed('dim', (n) => keep?.has(n.id) === false)
			.style('display', (n) =>
				keep ? (keep.has(n.id) ? null : 'none') : labelled(n) ? null : 'none',
			);
		const n = id === null ? undefined : nodes.find((x) => x.id === id);
		tip.textContent =
			n === undefined ? '' : `${n.item.key} · ${n.item.name}${n.item.closed ? ' (закрыта)' : ''}`;
	}
	nodeSel
		.on('pointerdown', (e) => {
			pointer = (e as PointerEvent).pointerType;
		})
		.on('pointerenter', (e, n) => {
			if ((e as PointerEvent).pointerType === 'mouse') focus(n.id);
		})
		.on('pointerleave', (e) => {
			if ((e as PointerEvent).pointerType === 'mouse') focus(null);
		})
		.on('click', (_e, n) => {
			// A first tap highlights, a second tap on the same node opens it; a mouse hover has done the first.
			if (pointer !== 'mouse' && focused !== n.id) focus(n.id);
			else openItem(n.item);
		});
	svg.on('click', (e) => {
		if (e.target instanceof SVGSVGElement) focus(null);
	});

	const sim = d3
		.forceSimulation(nodes)
		.force(
			'link',
			d3
				.forceLink<Node, Link>(links)
				.id((n) => n.id)
				.distance((l) => (l.type === 'parent' ? 34 : 58))
				.strength((l) => (l.type === 'blocks' ? 0.6 : 0.25)),
		)
		.force('charge', d3.forceManyBody().strength(-110))
		.force(
			'collide',
			d3.forceCollide((n: Node) => n.r + 3),
		)
		.force('y', d3.forceY(H / 2).strength(0.07))
		.force(
			'x',
			d3
				.forceX<Node>((n) => columnX(n.item.wave, maxWave, W) ?? W / 2)
				.strength((n) => (n.item.wave === null ? 0.04 : 0.9)),
		);
	simulation = sim;

	nodeSel.call(
		d3
			.drag<Node>()
			.on('start', (e, n) => {
				autoFit = false;
				if (e.active === 0) sim.alphaTarget(0.3).restart();
				n.fx = n.x;
				n.fy = n.y;
			})
			.on('drag', (e, n) => {
				n.fx = e.x;
				n.fy = e.y;
			})
			.on('end', (e, n) => {
				if (e.active === 0) sim.alphaTarget(0);
				n.fx = null;
				n.fy = null;
			}),
	);

	sim.on('tick', () => {
		linkSel.each(function (l) {
			const s = l.source as Node;
			const t = l.target as Node;
			const dx = (t.x ?? 0) - (s.x ?? 0);
			const dy = (t.y ?? 0) - (s.y ?? 0);
			const len = Math.hypot(dx, dy) || 1;
			const back = l.type === 'blocks' ? t.r + 2 : 0;
			d3.select(this)
				.attr('x1', s.x ?? 0)
				.attr('y1', s.y ?? 0)
				.attr('x2', (t.x ?? 0) - (dx / len) * back)
				.attr('y2', (t.y ?? 0) - (dy / len) * back);
		});
		nodeSel.attr('cx', (n) => n.x ?? 0).attr('cy', (n) => n.y ?? 0);
		labelSel.attr('x', (n) => n.x ?? 0).attr('y', (n) => n.y ?? 0);
	});

	fit = () => {
		const columns = Array.from({ length: maxWave + 1 }, (_, r) => columnX(r, maxWave, W) as number);
		const box = fitBox(
			nodes.map((n) => ({ x: n.x ?? 0, y: n.y ?? 0, r: n.r })),
			columns,
			H,
		);
		const { x0, x1, y0, y1 } = box;
		const k = Math.min(1.6, W / (x1 - x0), H / (y1 - y0));
		svg
			.transition()
			.duration(400)
			.call(
				zoom.transform,
				d3.zoomIdentity.translate((W - k * (x1 + x0)) / 2, (H - k * (y1 + y0)) / 2).scale(k),
			);
	};
	sim.on('end', () => {
		// d3 fires `end` after every cool-down (a drag restarts the simulation); only the first one fits.
		if (!autoFit) return;
		autoFit = false;
		fit();
	});
}

/** The id behind a link end, before and after d3 swaps ids for node objects. */
function ref(end: string | Node): string {
	return typeof end === 'string' ? end : end.id;
}

/** Filters changed or fresh data arrived: redraw everything that depends on them. */
function refresh(): void {
	renderPanels();
	drawGraph();
}

async function load(): Promise<void> {
	// Only the latest request may touch the page: a slow older answer must not overwrite a newer one.
	const seq = ++loadSeq;
	try {
		const res = await fetch(DATA_URL, {
			cache: 'no-store',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`graph.json ${res.status}`);
		const next = parseGraph(await res.json());
		if (seq !== loadSeq) return;
		renderOffline(false);
		// generatedAt changes on every request; it only counts when it is the header time (no sync yet).
		const key = JSON.stringify({
			...next,
			generatedAt: next.syncedAt === null ? next.generatedAt : '',
		});
		data = next;
		if (key === dataKey) return;
		dataKey = key;
		renderBar();
		refresh();
	} catch {
		if (seq === loadSeq) renderOffline(true);
	}
}

function boot(): void {
	if (root === null || DATA_URL === '') return;
	const style = document.createElement('style');
	style.textContent = CSS;
	document.head.append(style);
	offlineEl.className = 'offline';
	stageEl.className = 'stage';
	panelsEl.className = 'panels';
	barEl.className = 'bar';
	root.append(barEl, offlineEl, stageEl, panelsEl);

	loadD3().then(
		() => {
			d3State = 'ready';
			drawGraph();
		},
		() => {
			d3State = 'failed';
			drawGraph();
		},
	);
	void load();
	setInterval(() => void load(), REFRESH_MS);
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') void load();
	});
}

boot();
