import { describe, expect, test } from 'bun:test';

import { agentKeyOk, parseAgentRun, readKeyOk } from '../src/access.ts';
import type { TenantConfig } from '../src/config.ts';
import { esc } from '../src/html.ts';
import { graphPage, planeBlock } from '../src/page.ts';

const t: TenantConfig = {
	id: 'acme',
	workspaceSlug: 'example-ws',
	workspaceId: 'ws',
	clientId: 'c',
	installationId: 'i',
	planeSecret: 'p',
	webhookSecret: 'w',
	readKey: 'read-aaaa',
	agentKey: 'agent-bbbb',
};
const url = (q: string) => new URL(`http://localhost/t/acme/graph.json${q}`);
const req = (authorization?: string) =>
	new Request('http://localhost/x', authorization ? { headers: { authorization } } : {});

describe('readKeyOk', () => {
	test('только точное совпадение ключа чтения', () => {
		expect(readKeyOk(t, url('?k=read-aaaa'))).toBe(true);
		expect(readKeyOk(t, url('?k=read-aaaa&k=x'))).toBe(true);
		expect(readKeyOk(t, url(''))).toBe(false);
		expect(readKeyOk(t, url('?k='))).toBe(false);
		expect(readKeyOk(t, url('?k=read-aaa'))).toBe(false);
		expect(readKeyOk(t, url('?k=read-aaaaa'))).toBe(false);
		expect(readKeyOk(t, url('?k=agent-bbbb'))).toBe(false);
	});

	test('пустой ключ в конфиге не открывает ничего', () => {
		expect(readKeyOk({ ...t, readKey: '' }, url('?k='))).toBe(false);
		expect(agentKeyOk({ ...t, agentKey: '' }, req('Bearer '))).toBe(false);
	});
});

describe('agentKeyOk', () => {
	test('только Bearer с ключом агента', () => {
		expect(agentKeyOk(t, req('Bearer agent-bbbb'))).toBe(true);
		expect(agentKeyOk(t, req('bearer agent-bbbb'))).toBe(true);
		expect(agentKeyOk(t, req())).toBe(false);
		expect(agentKeyOk(t, req('agent-bbbb'))).toBe(false);
		expect(agentKeyOk(t, req('Basic agent-bbbb'))).toBe(false);
		expect(agentKeyOk(t, req('Bearer read-aaaa'))).toBe(false);
	});
});

const good = () => ({
	runId: 'r1',
	kind: 'daily' as const,
	startedAt: '2026-02-01T10:00:00Z',
	finishedAt: '2026-02-01T10:05:00Z',
	relationsAdded: [{ fromId: 'a', toId: 'b' }],
	labelsAdded: [{ itemId: 'c', label: 'код:x' }],
	skipped: 2,
	costUsd: 1.5,
});

describe('parseAgentRun', () => {
	test('верное тело возвращается без лишних полей', () => {
		expect(
			parseAgentRun({
				...good(),
				extra: 1,
				relationsAdded: [{ fromId: 'a', toId: 'b', note: 'x' }],
			}),
		).toEqual(good());
	});

	test('имя первого неверного поля — путь', () => {
		expect(parseAgentRun({ ...good(), runId: 5 })).toEqual({ error: 'runId' });
		expect(parseAgentRun({ ...good(), kind: 'weekly' })).toEqual({ error: 'kind' });
		expect(parseAgentRun({ ...good(), relationsAdded: [{ fromId: 'a' }] })).toEqual({
			error: 'relationsAdded[0].toId',
		});
		expect(parseAgentRun({ ...good(), labelsAdded: [{ itemId: 'c', label: 'x' }, 7] })).toEqual({
			error: 'labelsAdded[1]',
		});
		expect(parseAgentRun({ ...good(), costUsd: Number.NaN })).toEqual({ error: 'costUsd' });
		expect(parseAgentRun('x')).toEqual({ error: 'body' });
	});
});

describe('страница', () => {
	const evil = '"><script>alert(1)</script>&';
	test('адреса проходят через esc', () => {
		for (const html of [
			graphPage({ scriptUrl: evil, dataUrl: evil }),
			planeBlock({ scriptUrl: evil, dataUrl: evil }),
		]) {
			expect(html).not.toContain('<script>alert');
			expect(html).toContain(`src="${esc(evil)}"`);
			expect(html).toContain(`data-graph="${esc(evil)}"`);
		}
	});

	test('d3 с integrity и crossorigin', () => {
		const html = graphPage({ scriptUrl: '/a.js', dataUrl: '/d' });
		expect(html).toContain('https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js');
		expect(html).toContain(
			'integrity="sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i"',
		);
		expect(html).toContain('crossorigin="anonymous"');
	});
});
