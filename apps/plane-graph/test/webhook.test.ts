// Adapted from apps/plane-miro/test/plane-webhook.test.ts.
import { createHmac } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
	BadDelivery,
	deliveryWorkspace,
	parsePlaneDelivery,
	type PlaneEvent,
	verifyPlaneSignature,
} from '../src/plane/webhook.ts';
import { fixture } from './fixtures.ts';

const parse = (name: string, extra: Record<string, string> = {}): PlaneEvent | null => {
	const fx = fixture(name);
	return parsePlaneDelivery('initech', new Headers({ ...fx.headers, ...extra }), fx.raw);
};
const parseBody = (body: unknown, headers = new Headers()): PlaneEvent | null =>
	parsePlaneDelivery('initech', headers, JSON.stringify(body));
/** The fixture body after `edit` (deep copy). */
function edited(name: string, edit: (body: any) => void): unknown {
	const body = structuredClone(fixture(name).body) as any;
	edit(body);
	return body;
}
const at = (name: string, path: string): any =>
	path.split('.').reduce((v: any, key) => v[key], fixture(name).body);

const TOUCHED = [
	'plane-issue-state',
	'plane-issue-created',
	'plane-issue-labels',
	'plane-relation-created',
	'plane-relates-created',
];
const RELATION_REMOVED = ['plane-relation-deleted', 'plane-relates-deleted'];

describe('parsePlaneDelivery: задача', () => {
	test('создание, смена состояния, метки, связь «блокирует» и «связана» → item.touched с проектом и одним id', () => {
		for (const name of TOUCHED) {
			const e = parse(name);
			expect(e, name).toEqual({
				kind: 'item.touched',
				tenant: 'initech',
				eventKey: `issue.touched:${at(name, 'data.id')}:${at(name, 'activity.field') ?? ''}:${at(name, 'data.last_activity_at')}`,
				projectId: at(name, 'data.project'),
				workItemIds: [at(name, 'data.id')],
			});
			// the ids are not mixed up
			expect(at(name, 'data.project')).not.toBe(at(name, 'data.id'));
		}
	});

	test('связь: вторая задача из тела не берётся', () => {
		const e = parse('plane-relation-created');
		expect(e).toMatchObject({ kind: 'item.touched' });
		expect(e?.kind === 'item.touched' ? e.workItemIds : []).toHaveLength(1);
	});

	test('удаление задачи (поле issue) → item.deleted с id и ключом по нему', () => {
		expect(parse('plane-issue-deleted')).toEqual({
			kind: 'item.deleted',
			tenant: 'initech',
			eventKey: `issue.deleted:${at('plane-issue-deleted', 'data.id')}`,
			workItemId: at('plane-issue-deleted', 'data.id'),
		});
	});

	test('снятие связи — не удаление: item.touched без проекта, задача жива', () => {
		for (const name of RELATION_REMOVED) {
			const e = parse(name, { 'x-plane-delivery': 'd-1' });
			expect(e, name).toEqual({
				kind: 'item.touched',
				tenant: 'initech',
				eventKey: `issue.touched:${at(name, 'data.id')}:${at(name, 'activity.field')}:d-1`,
				projectId: null,
				workItemIds: [at(name, 'data.id')],
			});
			expect(e?.kind).not.toBe('item.deleted');
		}
	});

	test('снятие любого другого поля (ссылка, вложение, модуль) тоже перечитывает задачу', () => {
		for (const f of ['link', 'attachment', 'modules', 'cycles', 'reaction', null])
			expect(
				parseBody(edited('plane-relation-deleted', (b) => (b.activity.field = f))),
				String(f),
			).toMatchObject({ kind: 'item.touched', projectId: null });
	});

	test('ключ снятия связи: без x-plane-delivery — по телу; повтор доставки тот же, другое тело другой', () => {
		const a = parse('plane-relation-deleted')!;
		expect(parse('plane-relation-deleted')!.eventKey).toBe(a.eventKey);
		expect(a.eventKey).toMatch(/:[0-9a-f]{32}$/);
		expect(parse('plane-relates-deleted')!.eventKey).not.toBe(a.eventKey);
		expect(parse('plane-relation-deleted', { 'x-plane-delivery': 'd-2' })!.eventKey).not.toBe(
			a.eventKey,
		);
	});

	test('два изменения одной задачи с разным last_activity_at → разные eventKey; повтор — тот же', () => {
		const a = parse('plane-issue-state')!;
		const later = parseBody(
			edited('plane-issue-state', (b) => (b.data.last_activity_at = '2026-11-01T11:00:00.000000Z')),
		)!;
		expect(later.eventKey).not.toBe(a.eventKey);
		expect(parse('plane-issue-state')!.eventKey).toBe(a.eventKey);
		const other = parseBody(edited('plane-issue-state', (b) => (b.activity.field = 'name')))!;
		expect(other.eventKey).not.toBe(a.eventKey);
	});

	test('комментарий, другие сущности и действия → null', () => {
		expect(
			parseBody({ event: 'issue_comment', action: 'created', data: {}, activity: {} }),
		).toBeNull();
		for (const [event, action] of [
			['cycle', 'updated'],
			['project', 'created'],
			['issue', 'archived'],
			['issue_comment', 'updated'],
		])
			expect(
				parseBody(edited('plane-issue-state', (b) => ((b.event = event), (b.action = action)))),
				`${event}/${action}`,
			).toBeNull();
		// ignored deliveries are not validated further: no data needed
		expect(parseBody({ event: 'issue_comment', action: 'created' })).toBeNull();
		expect(parseBody({ event: 'issue', action: 'archived' })).toBeNull();
	});

	test('доставка не той формы → BadDelivery с именем поля, без значений', () => {
		const cases: Array<[unknown, string]> = [
			[null, 'body is not an object'],
			[[], 'body is not an object'],
			[{ event: 'issue' }, 'event or action is not a string'],
			[edited('plane-issue-state', (b) => delete b.activity), 'body.activity is not an object'],
			[
				edited('plane-issue-state', (b) => (b.activity.field = 7)),
				'activity.field is not a string',
			],
			[edited('plane-issue-state', (b) => delete b.data), 'body.data is not an object'],
			[edited('plane-issue-state', (b) => (b.data.id = '')), 'data.id is not a string'],
			[edited('plane-issue-state', (b) => delete b.data.project), 'data.project is not a string'],
			[
				edited('plane-issue-state', (b) => delete b.data.last_activity_at),
				'data.last_activity_at is not a string',
			],
		];
		for (const [body, message] of cases) {
			expect(() => parseBody(body), message).toThrow(BadDelivery);
			expect(() => parseBody(body)).toThrow(message);
		}
		expect(() => parsePlaneDelivery('t', new Headers(), 'not json')).toThrow(
			'body is not an object',
		);
	});
});

describe('deliveryWorkspace и подпись', () => {
	test('workspace_id берётся из тела; не JSON и не строка → null', () => {
		const fx = fixture('plane-issue-state');
		expect(deliveryWorkspace(fx.raw)).toBe((fx.body as any).workspace_id);
		for (const raw of ['not json', 'null', '[]', '{}', '{"workspace_id":7}'])
			expect(deliveryWorkspace(raw), raw).toBeNull();
	});

	test('подпись фикстуры сходится с test-secret и не сходится ни с чем иным', () => {
		const fx = fixture('plane-issue-state');
		const bytes = new TextEncoder().encode(fx.raw);
		const sig = fx.headers['x-plane-signature']!;
		expect(verifyPlaneSignature('test-secret', sig, bytes)).toBe(true);
		expect(verifyPlaneSignature('test-secret', sig.toUpperCase(), bytes)).toBe(true);
		expect(verifyPlaneSignature('other-secret', sig, bytes)).toBe(false);
		expect(verifyPlaneSignature('test-secret', sig, new TextEncoder().encode(`${fx.raw} `))).toBe(
			false,
		);
		for (const bad of [null, '', 'zz', sig.slice(2), `${sig}00`])
			expect(verifyPlaneSignature('test-secret', bad, bytes), String(bad)).toBe(false);
		const own = createHmac('sha256', 'k').update(bytes).digest('hex');
		expect(verifyPlaneSignature('k', own, bytes)).toBe(true);
	});
});
