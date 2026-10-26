/// <reference lib="dom" />
import { api } from './api.ts';
import {
	bindableId,
	convertibleIds,
	convertInBatches,
	currentSelection,
	errorText,
	type Outcome,
	summary,
} from './logic.ts';

type Project = { id: string; identifier: string; name: string };
type Hit = { id: string; projectId: string; key: string; name: string };

const STORAGE_KEY = 'plane-miro:project';
const SEARCH_DELAY_MS = 300;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const projectEl = $('project') as HTMLSelectElement;
const countEl = $('count');
const convertEl = $('convert') as HTMLButtonElement;
const queryEl = $('query') as HTMLInputElement;
const hitsEl = $('hits');
const bindEl = $('bind') as HTMLButtonElement;
const statusEl = $('status');

let selection: { id: string; type: string }[] = [];
// Set once a selection:update arrives; the start-up read must not overwrite it.
let updatedSelection: { id: string; type: string }[] | null = null;
let hits: Hit[] = [];
let picked: Hit | null = null;
let busy = false;
let searchSeq = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function say(text: string, isError = false): void {
	statusEl.textContent = text;
	statusEl.className = isError ? 'error' : '';
}

function refresh(): void {
	const count = convertibleIds(selection).length;
	countEl.textContent = `Выделено для Plane: ${count}`;
	convertEl.disabled = busy || count === 0 || projectEl.value === '';
	bindEl.disabled = busy || bindableId(selection) === null || picked === null;
	projectEl.disabled = busy;
}

/** Runs one request-chain; the buttons stay off until it ends, however it ends. */
async function exclusive(work: () => Promise<void>): Promise<void> {
	if (busy) return;
	busy = true;
	refresh();
	try {
		await work();
	} finally {
		busy = false;
		refresh();
	}
}

function remembered(): string | null {
	try {
		return localStorage.getItem(STORAGE_KEY);
	} catch {
		return null;
	}
}

function remember(id: string): void {
	try {
		localStorage.setItem(STORAGE_KEY, id);
	} catch {
		// Private mode or blocked storage: the choice just is not kept.
	}
}

function renderHits(): void {
	hitsEl.replaceChildren(
		...hits.map((hit) => {
			const li = document.createElement('li');
			li.textContent = `${hit.key} ${hit.name}`;
			if (hit === picked) li.className = 'picked';
			li.addEventListener('click', () => {
				picked = hit;
				renderHits();
				refresh();
			});
			return li;
		}),
	);
}

async function search(query: string): Promise<void> {
	const seq = ++searchSeq;
	if (query === '') {
		hits = [];
		picked = null;
		renderHits();
		refresh();
		return;
	}
	const res = await api<{ items: Hit[] }>(
		`/miro/api/search?${new URLSearchParams({ q: query }).toString()}`,
	);
	// A newer query was typed while this one was in flight.
	if (seq !== searchSeq) return;
	picked = null;
	if (res.ok) {
		hits = res.data.items;
		say(hits.length === 0 ? 'Ничего не найдено.' : '');
	} else {
		hits = [];
		say(errorText(res.error), true);
	}
	renderHits();
	refresh();
}

async function convert(): Promise<void> {
	const current = await miro.board.getSelection();
	const ids = convertibleIds(current);
	if (ids.length === 0) return;
	const [{ id: boardId }, { name: author }] = await Promise.all([
		miro.board.getInfo(),
		miro.board.getUserInfo(),
	]);
	const results = await convertInBatches(
		ids,
		(batch) =>
			api<{ results: Outcome[] }>('/miro/api/convert', {
				method: 'POST',
				body: JSON.stringify({ boardId, projectId: projectEl.value, author, itemIds: batch }),
			}),
		(done, total) => {
			say(`Переношу: ${done} из ${total}…`);
		},
	);
	say(
		summary(results),
		results.some((r) => !r.ok),
	);
}

async function bind(): Promise<void> {
	const target = picked;
	const current = await miro.board.getSelection();
	const itemId = bindableId(current);
	if (target === null || itemId === null) return;
	const [{ id: boardId }, { name: author }] = await Promise.all([
		miro.board.getInfo(),
		miro.board.getUserInfo(),
	]);
	const res = await api<{ result: Outcome }>('/miro/api/bind', {
		method: 'POST',
		body: JSON.stringify({
			boardId,
			itemId,
			workItemId: target.id,
			projectId: target.projectId,
			author,
		}),
	});
	const outcome: Outcome = res.ok ? res.data.result : { ok: false, error: res.error };
	say(summary([outcome]), !outcome.ok);
}

/** A failure outside the request (the SDK refusing a call) is shown like any other. */
const guard = (work: () => Promise<void>) => () =>
	void exclusive(work).catch(() => {
		say(errorText('unknown'), true);
	});

convertEl.addEventListener('click', guard(convert));
bindEl.addEventListener('click', guard(bind));
projectEl.addEventListener('change', () => {
	remember(projectEl.value);
	refresh();
});
queryEl.addEventListener('input', () => {
	clearTimeout(searchTimer);
	searchTimer = setTimeout(() => void search(queryEl.value.trim()), SEARCH_DELAY_MS);
});

miro.board.ui.on('selection:update', ({ items }) => {
	updatedSelection = items;
	selection = items;
	refresh();
});

const [projects, current] = await Promise.all([
	api<{ projects: Project[] }>('/miro/api/projects'),
	miro.board.getSelection(),
]);
selection = currentSelection(updatedSelection, current);
if (projects.ok) {
	projectEl.replaceChildren(
		...projects.data.projects.map((p) => {
			const option = document.createElement('option');
			option.value = p.id;
			option.textContent = `${p.identifier} ${p.name}`;
			return option;
		}),
	);
	const last = remembered();
	if (last !== null && projects.data.projects.some((p) => p.id === last)) projectEl.value = last;
} else {
	say(errorText(projects.error), true);
}
refresh();
