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

	test('state_id → workitem.updated, previous.stateId = old_value', () => {
		const event = parse('plane-app-workitem-state-done');
		expect(event).toMatchObject({
			kind: 'workitem.updated',
			tenant: 'initech',
			eventKey: `issue.updated:${ID(3)}:state_id:2026-10-22T14:10:07.079913Z:d21ce489ad2594bb`,
			actorId: ID(8),
			previous: { stateId: ID(4) },
			item: { id: ID(3), stateId: ID(9), assignees: [ID(8)] },
		});
		expect(Object.keys((event as { previous: object }).previous)).toEqual(['stateId']);
	});

	test('assignee_ids → previous.assignees = []', () => {
		const event = parse('plane-app-workitem-assigned');
		expect(event).toMatchObject({
			kind: 'workitem.updated',
			previous: { assignees: [] },
			item: { assignees: [ID(8)] },
		});
		expect(Object.keys((event as { previous: object }).previous)).toEqual(['assignees']);
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

	test('assignee_ids с непустым old_value → previous.assignees — те же id', () => {
		const event = parseBody(
			edited('plane-app-workitem-assigned', (b) => {
				b.activity.old_value = [ID(8), ID(9)];
			}),
		);
		expect(event).toMatchObject({ previous: { assignees: [ID(8), ID(9)] } });
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

	test('человеческий двойник (field state), agent_run_user_prompt, created с field modules, удаление → null', () => {
		const human = (field: string) =>
			edited('plane-app-workitem-state-done', (b) => {
				b.activity.field = field;
			});
		for (const field of ['state', 'assignees', 'description', 'name', 'priority'])
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
		const a = parse('plane-app-workitem-state-done')!;
		const later = parseBody(
			edited('plane-app-workitem-state-done', (b) => {
				b.data.last_activity_at = '2026-10-22T15:00:00.000000Z';
			}),
		)!;
		const other = parseBody(
			edited('plane-app-workitem-state-done', (b) => {
				b.activity.field = 'assignee_ids';
				b.activity.old_value = [];
			}),
		)!;
		expect(new Set([a.eventKey, later.eventKey, other.eventKey]).size).toBe(3);
		expect(later.eventKey).toBe(
			`issue.updated:${ID(3)}:state_id:2026-10-22T15:00:00.000000Z:d21ce489ad2594bb`,
		);
		// a repeat of one delivery keeps its key
		expect(parse('plane-app-workitem-state-done')!.eventKey).toBe(a.eventKey);
	});

	test('state_id с old_value null → событие принято, previous.stateId не выставлен', () => {
		const event = parseBody(
			edited('plane-app-workitem-state-done', (b) => (b.activity.old_value = null)),
		) as { kind: string; previous: object };
		expect(event.kind).toBe('workitem.updated');
		expect(event.previous).toEqual({});
	});

	test('два изменения одного поля в одну метку last_activity_at → разные eventKey; повтор — тот же', () => {
		const change = (oldValue: string, newValue: string) =>
			edited('plane-app-workitem-state-done', (b) => {
				b.activity.old_value = oldValue;
				b.activity.new_value = newValue;
			});
		const a = parseBody(change(ID(4), ID(9)))!;
		const b = parseBody(change(ID(9), ID(4)))!;
		const c = parseBody(change(ID(4), ID(5)))!;
		expect(new Set([a.eventKey, b.eventKey, c.eventKey]).size).toBe(3);
		expect(parseBody(change(ID(4), ID(9)))!.eventKey).toBe(a.eventKey);
		// the hash is 16 hex chars after the timestamp
		expect(a.eventKey).toMatch(/:\d{2}:\d{2}\.\d+Z:[0-9a-f]{16}$/);
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
			edited('plane-app-workitem-state-done', (b) => (b.activity.old_value = 5)),
			edited('plane-app-workitem-state-done', (b) => delete b.data.last_activity_at),
			edited('plane-app-workitem-assigned', (b) => (b.activity.old_value = 'x')),
			edited('plane-app-workitem-assigned', (b) => (b.activity.old_value = [5])),
			edited('plane-app-workitem-assigned', (b) => (b.activity.old_value = [''])),
			edited('plane-app-workitem-state-done', (b) => {
				b.activity.field = 'description_html';
				b.activity.old_value = 5;
			}),
		];
		for (const body of hostile) expect(() => parseBody(body)).toThrow(BadDelivery);
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
