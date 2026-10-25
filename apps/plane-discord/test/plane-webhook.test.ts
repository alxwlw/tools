import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
	BadDelivery,
	deliveryWorkspace,
	parsePlaneDelivery,
	verifyPlaneSignature,
	type PlaneEvent,
} from '../src/plane/webhook.ts';
import { fixture } from './fixtures.ts';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const parse = (name: string): PlaneEvent | null => {
	const fx = fixture(name);
	return parsePlaneDelivery('initech', new Headers(fx.headers), fx.raw);
};
const parseBody = (body: unknown): PlaneEvent | null =>
	parsePlaneDelivery('initech', new Headers(), JSON.stringify(body));
/** The fixture body after `edit` (deep copy). */
function edited(name: string, edit: (body: any) => void): unknown {
	const body = structuredClone(fixture(name).body) as any;
	edit(body);
	return body;
}

/** The Plane "human" twin of a state change (REST v1 sends only this one): names in values, uuids in identifiers. */
const humanState = (
	oldId: string | null,
	newId: string | null,
	edit: (b: any) => void = () => {},
) =>
	edited('plane-app-workitem-state-done', (b) => {
		b.activity.field = 'state';
		b.activity.old_value = oldId === null ? null : 'Backlog';
		b.activity.new_value = 'Done';
		b.activity.old_identifier = oldId;
		b.activity.new_identifier = newId;
		edit(b);
	});
/** The human twin of one person added (`added`) or removed (`removed`) from the snapshot's assignees. */
const humanAssignee = (
	who: { added?: string; removed?: string },
	edit: (b: any) => void = () => {},
) =>
	edited('plane-app-workitem-assigned', (b) => {
		b.activity.field = 'assignees';
		b.activity.old_value = who.removed ? 'User9' : '';
		b.activity.new_value = who.added ? 'User5' : '';
		b.activity.old_identifier = who.removed ?? null;
		b.activity.new_identifier = who.added ?? null;
		edit(b);
	});

describe('parsePlaneDelivery', () => {
	test('created → workitem.created с id, projectId, sequenceId, stateId; actorId — бот', () => {
		const event = parse('plane-app-workitem-created');
		expect(event).toEqual({
			kind: 'workitem.created',
			tenant: 'initech',
			eventKey: `issue.created:${ID(3)}`,
			actorId: ID(6),
			item: {
				id: ID(3),
				projectId: ID(7),
				sequenceId: 57,
				name: `plane-discord probe ${ID(5)}`,
				stateId: ID(4),
				assignees: [],
				descriptionHtml: '<p></p>',
			},
		});
	});

	test('человеческий двойник state → workitem.updated, previous.stateId = old_identifier', () => {
		const event = parseBody(humanState(ID(4), ID(9)));
		expect(event).toMatchObject({
			kind: 'workitem.updated',
			tenant: 'initech',
			actorId: ID(8),
			previous: { stateId: ID(4) },
			item: { id: ID(3), stateId: ID(9), assignees: [ID(8)] },
		});
		expect((event as PlaneEvent).eventKey).toMatch(
			new RegExp(`^issue\\.updated:${ID(3)}:state:2026-10-22T14:10:07\\.079913Z:[0-9a-f]{16}$`),
		);
		expect(Object.keys((event as { previous: object }).previous)).toEqual(['stateId']);
	});

	test('машинные двойники state_id и assignee_ids → null (иначе смена в UI уведомляет дважды)', () => {
		expect(parse('plane-app-workitem-state-done')).toBeNull();
		expect(parse('plane-app-workitem-assigned')).toBeNull();
	});

	test('человеческий двойник assignees: добавлен → previous.assignees = снимок без него; снят → null', () => {
		const snapshotWith = (b: any) =>
			(b.data.assignees = [{ id: ID(8) }, { id: ID(14) }, { id: ID(15) }]);
		const added = parseBody(humanAssignee({ added: ID(14) }, snapshotWith));
		expect(added).toMatchObject({
			kind: 'workitem.updated',
			previous: { assignees: [ID(8), ID(15)] },
			item: { assignees: [ID(8), ID(14), ID(15)] },
		});
		expect(Object.keys((added as { previous: object }).previous)).toEqual(['assignees']);
		expect(parseBody(humanAssignee({ removed: ID(14) }, snapshotWith))).toBeNull();
		// the only assignee added: nobody was assigned before
		expect(parseBody(humanAssignee({ added: ID(8) }))).toMatchObject({
			previous: { assignees: [] },
		});
	});

	test('description_html → previous.descriptionHtml = old_value', () => {
		const body = edited('plane-app-workitem-state-done', (b) => {
			b.activity.field = 'description_html';
			b.activity.old_value = '<p>old</p>';
		});
		const event = parseBody(body);
		expect(event).toMatchObject({
			kind: 'workitem.updated',
			previous: { descriptionHtml: '<p>old</p>' },
		});
		expect(Object.keys((event as { previous: object }).previous)).toEqual(['descriptionHtml']);
		const empty = parseBody(
			edited('plane-app-workitem-state-done', (b) => {
				b.activity.field = 'description_html';
				b.activity.old_value = null;
			}),
		);
		expect(empty).toMatchObject({ previous: { descriptionHtml: null } });
	});

	test('человеческий двойник state без прежнего состояния → событие принято, previous пуст', () => {
		for (const oldId of [null, '']) {
			const event = parseBody(humanState(oldId, ID(9))) as { kind: string; previous: object };
			expect(event.kind).toBe('workitem.updated');
			expect(event.previous).toEqual({});
		}
	});

	test('отсутствующее поле html → null, а не ошибка', () => {
		const comment = parseBody(
			edited('plane-app-comment-mentions', (b) => {
				delete b.data.comment_html;
			}),
		);
		expect(comment).toMatchObject({ kind: 'comment.created', commentHtml: null });
		const created = parseBody(
			edited('plane-app-workitem-created', (b) => {
				delete b.data.description_html;
			}),
		);
		expect(created).toMatchObject({ kind: 'workitem.created', item: { descriptionHtml: null } });
	});

	test('issue_comment → comment.created, commentHtml из data.comment_html', () => {
		const event = parse('plane-app-comment-mentions');
		expect(event).toMatchObject({
			kind: 'comment.created',
			tenant: 'initech',
			actorId: ID(8),
			projectId: ID(7),
			workItemId: ID(3),
			commentId: ID(10),
		});
		const html = (fixture('plane-app-comment-mentions').body as any).data.comment_html;
		expect((event as { commentHtml: string }).commentHtml).toBe(html);
		expect(html).toContain('mention-component');
		const without = parseBody(
			edited('plane-app-comment-mentions', (b) => {
				b.data.comment_html = null;
			}),
		);
		expect(without).toMatchObject({ commentHtml: null });
	});

	test('agent_run_create → agent.mention с runId, commentId, workItemId', () => {
		expect(parse('plane-app-agent-run-create')).toEqual({
			kind: 'agent.mention',
			tenant: 'initech',
			eventKey: `agent_run:${ID(15)}`,
			projectId: ID(7),
			workItemId: ID(3),
			commentId: ID(10),
			runId: ID(15),
		});
		const noComment = parseBody(
			edited('plane-app-agent-run-create', (b) => {
				b.data.comment_id = null;
			}),
		);
		expect(noComment).toMatchObject({ kind: 'agent.mention', commentId: null });
		for (const edit of [(b: any) => delete b.data.comment_id, (b: any) => (b.data.comment_id = '')])
			expect(parseBody(edited('plane-app-agent-run-create', edit))).toMatchObject({
				kind: 'agent.mention',
				commentId: null,
			});
	});

	test('двойная доставка комментария → один eventKey', () => {
		const a = parse('plane-app-comment-mentions');
		const b = parse('plane-app-comment-mentions-dup');
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a!.eventKey).toBe(`comment.created:${ID(10)}`);
		expect(b!.eventKey).toBe(a!.eventKey);
	});

	test('поля name, priority, description, agent_run_user_prompt, created с field modules, удаление → null', () => {
		const human = (field: string) =>
			edited('plane-app-workitem-state-done', (b) => {
				b.activity.field = field;
			});
		for (const field of ['description', 'name', 'priority'])
			expect(parseBody(human(field))).toBeNull();
		expect(
			parseBody(edited('plane-app-agent-run-create', (b) => (b.event = 'agent_run_user_prompt'))),
		).toBeNull();
		expect(
			parseBody(edited('plane-app-workitem-created', (b) => (b.activity.field = 'modules'))),
		).toBeNull();
		expect(
			parseBody(edited('plane-app-workitem-created', (b) => (b.action = 'deleted'))),
		).toBeNull();
		expect(
			parseBody(edited('plane-app-workitem-state-done', (b) => (b.action = 'archived'))),
		).toBeNull();
		expect(
			parseBody(edited('plane-app-comment-mentions', (b) => (b.action = 'updated'))),
		).toBeNull();
		expect(
			parseBody(edited('plane-app-comment-mentions', (b) => (b.action = 'deleted'))),
		).toBeNull();
		expect(parseBody(edited('plane-app-workitem-created', (b) => (b.event = 'cycle')))).toBeNull();
		expect(
			parseBody(edited('plane-app-agent-run-create', (b) => (b.action = 'updated'))),
		).toBeNull();
		// ignored deliveries are not validated further: no data needed
		expect(parseBody({ event: 'issue', action: 'deleted' })).toBeNull();
		expect(
			parseBody({ event: 'issue', action: 'updated', activity: { field: 'name' } }),
		).toBeNull();
	});

	test('два изменения одной задачи с разным last_activity_at → разные eventKey', () => {
		const a = parseBody(humanState(ID(4), ID(9)))!;
		const later = parseBody(
			humanState(ID(4), ID(9), (b) => (b.data.last_activity_at = '2026-10-22T15:00:00.000000Z')),
		)!;
		const other = parseBody(humanAssignee({ added: ID(8) }))!;
		expect(new Set([a.eventKey, later.eventKey, other.eventKey]).size).toBe(3);
		expect(
			later.eventKey.startsWith(`issue.updated:${ID(3)}:state:2026-10-22T15:00:00.000000Z:`),
		).toBe(true);
		expect(other.eventKey.startsWith(`issue.updated:${ID(3)}:assignees:`)).toBe(true);
		// a repeat of one delivery keeps its key
		expect(parseBody(humanState(ID(4), ID(9)))!.eventKey).toBe(a.eventKey);
	});

	test('два изменения одного поля в одну метку last_activity_at → разные eventKey; повтор — тот же', () => {
		const a = parseBody(humanState(ID(4), ID(9)))!;
		const b = parseBody(humanState(ID(9), ID(4)))!;
		const c = parseBody(humanState(ID(4), ID(5)))!;
		expect(new Set([a.eventKey, b.eventKey, c.eventKey]).size).toBe(3);
		expect(parseBody(humanState(ID(4), ID(9)))!.eventKey).toBe(a.eventKey);
		// the hash is 16 hex chars after the timestamp
		expect(a.eventKey).toMatch(/:\d{2}:\d{2}\.\d+Z:[0-9a-f]{16}$/);
	});

	test('двое назначены одним запросом (одна метка, разные identifier) → разные eventKey; повтор — тот же', () => {
		const two = (b: any) => (b.data.assignees = [{ id: ID(8) }, { id: ID(14) }]);
		const first = parseBody(humanAssignee({ added: ID(8) }, two))!;
		const second = parseBody(humanAssignee({ added: ID(14) }, two))!;
		expect(first.eventKey).not.toBe(second.eventKey);
		expect(parseBody(humanAssignee({ added: ID(14) }, two))!.eventKey).toBe(second.eventKey);
	});

	test('description_html (машинный) → ключ по old_value/new_value, не по identifier', () => {
		const html = (oldValue: string, newValue: string) =>
			edited('plane-app-workitem-state-done', (b) => {
				b.activity.field = 'description_html';
				b.activity.old_value = oldValue;
				b.activity.new_value = newValue;
			});
		const a = parseBody(html('<p>a</p>', '<p>b</p>'))!;
		expect(a.eventKey).toMatch(/^issue\.updated:.+:description_html:.+:[0-9a-f]{16}$/);
		expect(parseBody(html('<p>a</p>', '<p>c</p>'))!.eventKey).not.toBe(a.eventKey);
		expect(parseBody(html('<p>a</p>', '<p>b</p>'))!.eventKey).toBe(a.eventKey);
	});

	test('враждебное тело → BadDelivery, не другое исключение', () => {
		const hostile: unknown[] = [
			null,
			[],
			'str',
			42,
			{},
			{ event: 1, action: 'created' },
			{ event: 'issue', action: 5 },
			edited('plane-app-workitem-created', (b) => (b.data.id = '')),
			{ event: 'issue', action: 'created' },
			{ event: 'issue', action: 'created', activity: null, data: {} },
			{ event: 'issue', action: 'created', activity: [], data: {} },
			{ event: 'issue', action: 'created', activity: { field: 5 }, data: {} },
			{ event: 'issue', action: 'created', activity: { field: null }, data: 'x' },
			{ event: 'issue_comment', action: 'created', activity: { field: null }, data: {} },
			{ event: 'agent_run_create', action: 'created', data: null },
			{ event: 'agent_run_create', action: 'created', data: { agent_run: 'x' } },
			edited('plane-app-agent-run-create', (b) => (b.data.comment_id = 5)),
			edited('plane-app-workitem-created', (b) => (b.data.sequence_id = '57')),
			edited('plane-app-workitem-created', (b) => (b.data.sequence_id = 1e300)),
			edited('plane-app-workitem-created', (b) => (b.data.sequence_id = -1)),
			edited('plane-app-workitem-created', (b) => (b.data.name = null)),
			edited('plane-app-workitem-created', (b) => (b.data.state = 'Done')),
			edited('plane-app-workitem-created', (b) => (b.data.assignees = 'x')),
			edited('plane-app-workitem-created', (b) => (b.data.assignees = [null])),
			edited('plane-app-workitem-created', (b) => (b.data.assignees = [{ id: 5 }])),
			edited('plane-app-workitem-created', (b) => (b.data.description_html = 5)),
			edited('plane-app-workitem-created', (b) => (b.activity.actor = null)),
			humanState(ID(4), ID(9), (b) => (b.activity.old_identifier = 5)),
			humanState(ID(4), ID(9), (b) => (b.activity.new_identifier = {})),
			humanState(ID(4), ID(9), (b) => delete b.data.last_activity_at),
			humanAssignee({ added: ID(8) }, (b) => (b.activity.new_identifier = 5)),
			humanAssignee({ added: ID(8) }, (b) => (b.activity.old_identifier = [])),
			// the identifiers are validated before a removal is dropped
			humanAssignee({ removed: ID(8) }, (b) => (b.activity.old_identifier = 5)),
			edited('plane-app-workitem-state-done', (b) => {
				b.activity.field = 'description_html';
				b.activity.old_value = 5;
			}),
		];
		for (const [i, body] of hostile.entries())
			expect(() => parseBody(body), String(i)).toThrow(BadDelivery);
		expect(() => parsePlaneDelivery('initech', new Headers(), 'not json')).toThrow(BadDelivery);
	});
});

describe('deliveryWorkspace', () => {
	test('workspace_id из JSON; не JSON, не объект, не строка → null', () => {
		expect(deliveryWorkspace(fixture('plane-app-workitem-created').raw)).toBe(ID(2));
		for (const raw of [
			'',
			'nope',
			'null',
			'[]',
			'"x"',
			'{}',
			'{"workspace_id":5}',
			'{"workspace_id":null}',
		])
			expect(deliveryWorkspace(raw)).toBeNull();
	});
});

describe('verifyPlaneSignature', () => {
	const raw = new TextEncoder().encode('{"a":1}');
	const sign = (secret: string, bytes: Uint8Array) =>
		createHmac('sha256', secret).update(bytes).digest('hex');
	test('верная — true; другой секрет, пустая, не-hex, другая длина — false', () => {
		const good = sign('s3cret', raw);
		expect(verifyPlaneSignature('s3cret', good, raw)).toBe(true);
		expect(verifyPlaneSignature('s3cret', good.toUpperCase(), raw)).toBe(true);
		expect(verifyPlaneSignature('other', good, raw)).toBe(false);
		expect(
			verifyPlaneSignature('s3cret', sign('s3cret', new TextEncoder().encode('{"a":2}')), raw),
		).toBe(false);
		expect(verifyPlaneSignature('s3cret', null, raw)).toBe(false);
		expect(verifyPlaneSignature('s3cret', '', raw)).toBe(false);
		expect(verifyPlaneSignature('s3cret', 'z'.repeat(64), raw)).toBe(false);
		expect(verifyPlaneSignature('s3cret', good.slice(0, 62), raw)).toBe(false);
		expect(verifyPlaneSignature('s3cret', `${good}00`, raw)).toBe(false);
		expect(verifyPlaneSignature('s3cret', ` ${good.slice(1)}`, raw)).toBe(false);
	});
	test('фикстуры подписаны test-secret', () => {
		for (const name of ['plane-app-workitem-created', 'plane-app-comment-mentions']) {
			const fx = fixture(name);
			expect(
				verifyPlaneSignature(
					'test-secret',
					fx.headers['x-plane-signature']!,
					new TextEncoder().encode(fx.raw),
				),
			).toBe(true);
		}
	});
});
