// Adapted from apps/plane-discord/test/plane-webhook.test.ts.
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
	BadDelivery,
	deliveryWorkspace,
	parsePlaneDelivery,
	verifyPlaneSignature,
	type PlaneEvent,
} from '../src/plane/webhook.ts';
import { fixture } from './fixtures.ts';

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
/** A field of a fixture body by dotted path. */
const at = (name: string, path: string): any =>
	path.split('.').reduce((v: any, key) => v[key], fixture(name).body);

const RENAMED = 'plane-issue-renamed';
const renamedTo = at(RENAMED, 'activity.new_value');
const field = (name: string, value: string) => edited(name, (b) => (b.activity.field = value));

describe('parsePlaneDelivery: задача', () => {
	test('переименование → workitem.changed с новым названием, id, проектом, номером, состоянием', () => {
		const e = parse(RENAMED);
		expect(e).toEqual({
			kind: 'workitem.changed',
			tenant: 'initech',
			eventKey: `issue.changed:${at(RENAMED, 'data.id')}:name:${at(RENAMED, 'data.last_activity_at')}`,
			item: {
				id: at(RENAMED, 'data.id'),
				projectId: at(RENAMED, 'data.project'),
				sequenceId: 102,
				name: renamedTo,
				stateId: at(RENAMED, 'data.state.id'),
				assignees: [],
			},
		});
		// the snapshot's ids are not mixed up
		const item = e?.kind === 'workitem.changed' ? e.item : null;
		expect(new Set([item?.id, item?.projectId, item?.stateId]).size).toBe(3);
	});

	test('смена статуса → workitem.changed, stateId — новый, ключ по полю state', () => {
		const e = parse('plane-issue-state');
		expect(e).toMatchObject({
			kind: 'workitem.changed',
			item: { stateId: at('plane-issue-state', 'data.state.id') },
		});
		expect(e?.eventKey).toBe(
			`issue.changed:${at('plane-issue-state', 'data.id')}:state:${at('plane-issue-state', 'data.last_activity_at')}`,
		);
	});

	test('оба двойника принимаются: state_id, assignees, assignee_ids → workitem.changed со своим полем в ключе', () => {
		for (const value of ['state', 'state_id', 'assignees', 'assignee_ids', 'name']) {
			const e = parseBody(field('plane-issue-state', value));
			expect(e).toMatchObject({ kind: 'workitem.changed' });
			expect(e?.eventKey).toContain(`:${value}:`);
		}
	});

	test('назначенные из снимка — id людей', () => {
		const e = parseBody(
			edited(RENAMED, (b) => {
				b.activity.field = 'assignees';
				b.data.assignees = [{ id: 'u-1' }, { id: 'u-2' }];
			}),
		);
		expect(e).toMatchObject({ kind: 'workitem.changed', item: { assignees: ['u-1', 'u-2'] } });
	});

	test('удаление → workitem.deleted с id задачи и ключом по нему', () => {
		const e = parse('plane-issue-deleted');
		expect(e).toEqual({
			kind: 'workitem.deleted',
			tenant: 'initech',
			eventKey: `issue.deleted:${at('plane-issue-deleted', 'data.id')}`,
			workItemId: at('plane-issue-deleted', 'data.id'),
		});
	});

	test('удаление не задачи (ссылка, вложение, модуль, цикл, реакция) → null; поле issue → workitem.deleted', () => {
		for (const f of ['link', 'attachment', 'modules', 'cycles', 'reaction'])
			expect(parseBody(edited('plane-issue-deleted', (b) => (b.activity.field = f))), f).toBeNull();
		expect(parseBody(edited('plane-issue-deleted', (b) => delete b.activity))).toBeNull();
		expect(parseBody(edited('plane-issue-deleted', (b) => (b.activity = []))), 'array').toBeNull();
		expect(
			parseBody(edited('plane-issue-deleted', (b) => (b.activity.field = 'issue'))),
		).toMatchObject({
			kind: 'workitem.deleted',
		});
	});

	test('description_html, priority, description, created без ссылки, архив → null', () => {
		for (const value of ['description_html', 'description', 'priority', 'modules', 'labels'])
			expect(parseBody(field(RENAMED, value)), value).toBeNull();
		expect(parseBody(edited(RENAMED, (b) => (b.activity.field = null)))).toBeNull();
		expect(parseBody(edited(RENAMED, (b) => (b.action = 'created')))).toBeNull();
		expect(parseBody(edited(RENAMED, (b) => (b.action = 'archived')))).toBeNull();
		expect(parseBody(edited(RENAMED, (b) => (b.event = 'cycle')))).toBeNull();
		expect(parseBody(edited(RENAMED, (b) => (b.event = 'project')))).toBeNull();
		// ignored deliveries are not validated further: no data needed
		expect(
			parseBody({ event: 'issue', action: 'updated', activity: { field: 'priority' } }),
		).toBeNull();
		expect(parseBody({ event: 'issue', action: 'archived' })).toBeNull();
	});

	test('два изменения одной задачи с разным last_activity_at → разные eventKey; повтор — тот же', () => {
		const a = parse(RENAMED)!;
		const later = parseBody(
			edited(RENAMED, (b) => (b.data.last_activity_at = '2026-10-26T11:00:00.000000Z')),
		)!;
		expect(later.eventKey).not.toBe(a.eventKey);
		expect(parse(RENAMED)!.eventKey).toBe(a.eventKey);
		const other = parseBody(field(RENAMED, 'state'))!;
		expect(other.eventKey).not.toBe(a.eventKey);
	});
});

describe('parsePlaneDelivery: ссылка в задаче', () => {
	test('ссылка в задаче → link.created с URL, автором, задачей и проектом', () => {
		const name = 'plane-issue-link-created';
		expect(parse(name)).toEqual({
			kind: 'link.created',
			tenant: 'initech',
			eventKey: expect.stringMatching(/^issue\.link:[^:]+:[0-9a-f]{32}$/),
			actorId: at(name, 'activity.actor.id'),
			projectId: at(name, 'data.project'),
			workItemId: at(name, 'data.id'),
			url: 'https://miro.com/app/board/uXjVexample1=/',
		});
	});

	test('ссылка, поставленная ботом через API → тот же link.created, actorId — бот', () => {
		const name = 'plane-issue-link-created-bot';
		const e = parse(name);
		expect(e).toMatchObject({
			kind: 'link.created',
			actorId: at(name, 'activity.actor.id'),
			url: expect.stringContaining('moveToWidget=3458764500000000001'),
		});
		expect(e?.eventKey).toMatch(/^issue\.link:[^:]+:[0-9a-f]{32}$/);
		expect(e?.kind === 'link.created' && e.actorId).not.toBe(
			at('plane-issue-link-created', 'activity.actor.id'),
		);
	});

	test('ключ ссылки — хеш: URL и его длина не попадают в ключ, new_identifier различает одинаковые URL', () => {
		const name = 'plane-issue-link-created';
		const withId = (id: string | null, url = 'https://x.example/?token=SECRET-9137') =>
			parseBody(
				edited(name, (b) => {
					b.activity.new_value = url;
					b.activity.new_identifier = id;
				}),
			)!;
		const a = withId('link-1');
		expect(a.eventKey).toMatch(new RegExp(`^issue\\.link:${at(name, 'data.id')}:[0-9a-f]{32}$`));
		expect(a.eventKey).not.toContain('SECRET');
		const digest = createHash('sha256')
			.update('link-1|https://x.example/?token=SECRET-9137')
			.digest('hex')
			.slice(0, 32);
		expect(a.eventKey).toBe(`issue.link:${at(name, 'data.id')}:${digest}`);
		const noId = createHash('sha256').update('|https://x.example/a').digest('hex').slice(0, 32);
		expect(withId(null, 'https://x.example/a').eventKey).toBe(
			`issue.link:${at(name, 'data.id')}:${noId}`,
		);
		expect(withId(null, 'https://x.example/a').eventKey).not.toBe(
			withId(null, 'https://x.example/b').eventKey,
		);
		expect(withId('link-1', 'https://x.example/a').eventKey).not.toBe(
			withId('link-1', 'https://x.example/b').eventKey,
		);
		expect(withId('link-2').eventKey).not.toBe(a.eventKey);
		expect(withId('link-1').eventKey).toBe(a.eventKey);
		expect(withId(null).eventKey).not.toBe(a.eventKey);
		expect(withId('link-1', 'https://x.example/?' + 'a'.repeat(100_000)).eventKey).toHaveLength(
			a.eventKey.length,
		);
		expect(a.kind === 'link.created' && a.url).toBe('https://x.example/?token=SECRET-9137');
	});

	test('две разные ссылки в одной задаче → разные ключи', () => {
		const a = parse('plane-issue-link-created')!;
		const b = parse('plane-issue-link-created-bot')!;
		expect(a.eventKey).not.toBe(b.eventKey);
	});

	test('ссылка без url (new_value пуст) → BadDelivery', () => {
		expect(() =>
			parseBody(edited('plane-issue-link-created', (b) => (b.activity.new_value = null))),
		).toThrow(BadDelivery);
	});
});

describe('parsePlaneDelivery: комментарий', () => {
	test('комментарий со ссылкой Miro → comment.created, commentHtml содержит miro.com', () => {
		const name = 'plane-comment-miro-link';
		const e = parse(name);
		expect(e).toEqual({
			kind: 'comment.created',
			tenant: 'initech',
			eventKey: `comment.created:${at(name, 'data.id')}`,
			actorId: at(name, 'activity.actor.id'),
			projectId: at(name, 'data.project'),
			workItemId: at(name, 'data.issue'),
			commentId: at(name, 'data.id'),
			commentHtml: at(name, 'data.comment_html'),
		});
		expect(e?.kind === 'comment.created' && e.commentHtml).toContain('miro.com/app/board/');
	});

	test('двойная доставка комментария → один eventKey', () => {
		expect(parse('plane-comment-miro-link-dup')!.eventKey).toBe(
			parse('plane-comment-miro-link')!.eventKey,
		);
	});

	test('отсутствующее поле html → null, а не ошибка', () => {
		const comment = parseBody(
			edited('plane-comment-miro-link', (b) => {
				delete b.data.comment_html;
			}),
		);
		expect(comment).toMatchObject({ kind: 'comment.created', commentHtml: null });
	});

	test('comment_html: null → commentHtml null', () => {
		expect(
			parseBody(edited('plane-comment-miro-link', (b) => (b.data.comment_html = null))),
		).toMatchObject({ kind: 'comment.created', commentHtml: null });
	});

	test('изменение и удаление комментария → null', () => {
		for (const action of ['updated', 'deleted'])
			expect(
				parseBody(edited('plane-comment-miro-link', (b) => (b.action = action))),
				action,
			).toBeNull();
	});
});

describe('parsePlaneDelivery: враждебные тела', () => {
	test('враждебное тело → BadDelivery, не другое исключение', () => {
		const hostile: unknown[] = [
			null,
			[],
			'str',
			42,
			{},
			{ event: 1, action: 'created' },
			{ event: 'issue', action: 5 },
			{ event: 'issue', action: 'created' },
			{ event: 'issue', action: 'created', activity: null, data: {} },
			{ event: 'issue', action: 'created', activity: [], data: {} },
			{ event: 'issue', action: 'created', activity: { field: 5 }, data: {} },
			{ event: 'issue', action: 'updated', activity: { field: 'name' }, data: 'x' },
			{ event: 'issue_comment', action: 'created', activity: { field: null }, data: {} },
			{ event: 'issue', action: 'deleted', activity: { field: 'issue' } },
			{ event: 'issue', action: 'deleted', activity: { field: 'issue' }, data: {} },
			{ event: 'issue', action: 'deleted', activity: { field: 'issue' }, data: { id: 7 } },
			edited(RENAMED, (b) => (b.data.id = '')),
			edited(RENAMED, (b) => (b.data.sequence_id = '57')),
			edited(RENAMED, (b) => (b.data.sequence_id = 1e300)),
			edited(RENAMED, (b) => (b.data.sequence_id = -1)),
			edited(RENAMED, (b) => (b.data.name = null)),
			edited(RENAMED, (b) => (b.data.state = 'Done')),
			edited(RENAMED, (b) => (b.data.state = { name: 'x' })),
			edited(RENAMED, (b) => (b.data.assignees = 'x')),
			edited(RENAMED, (b) => (b.data.assignees = [null])),
			edited(RENAMED, (b) => (b.data.assignees = [{ id: 5 }])),
			edited(RENAMED, (b) => (b.data.assignees = [{ id: '' }])),
			edited(RENAMED, (b) => delete b.data.last_activity_at),
			edited(RENAMED, (b) => delete b.data.project),
			edited('plane-issue-link-created', (b) => (b.activity.actor = null)),
			edited('plane-issue-link-created', (b) => (b.activity.new_value = 5)),
			edited('plane-issue-link-created', (b) => delete b.data.project),
			edited('plane-issue-link-created', (b) => delete b.data.id),
			edited('plane-comment-miro-link', (b) => (b.activity.actor = null)),
			edited('plane-comment-miro-link', (b) => (b.data.comment_html = 5)),
			edited('plane-comment-miro-link', (b) => delete b.data.issue),
		];
		for (const [i, body] of hostile.entries())
			expect(() => parseBody(body), String(i)).toThrow(BadDelivery);
		expect(() => parsePlaneDelivery('initech', new Headers(), 'not json')).toThrow(BadDelivery);
	});
});

describe('deliveryWorkspace', () => {
	test('workspace_id из JSON; не JSON, не объект, не строка → null', () => {
		expect(deliveryWorkspace(fixture(RENAMED).raw)).toBe(at(RENAMED, 'workspace_id'));
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
		for (const name of [RENAMED, 'plane-comment-miro-link', 'plane-issue-link-created']) {
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
