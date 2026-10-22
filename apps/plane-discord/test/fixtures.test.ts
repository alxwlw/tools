import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { FIXTURES_DIR, fixture } from './fixtures.ts';

const NAMES = [
	'plane-app-agent-run-create',
	'plane-app-comment-mentions',
	'plane-app-comment-mentions-dup',
	'plane-app-workitem-assigned',
	'plane-app-workitem-created',
	'plane-app-workitem-state-done',
	'plane-comment-get-mention',
];

type Delivery = {
	event: string;
	action: string;
	workspace_id: string;
	activity: { field: string | null; actor?: { id: string } };
	data: Record<string, unknown>;
};
const delivery = (name: string): Delivery => fixture(name).body as Delivery;

test('в каталоге ровно фикстуры из плана', () => {
	const files = readdirSync(FIXTURES_DIR).sort();
	expect(files).toEqual(NAMES.map((n) => `${n}.json`).sort());
});

test('каждая фикстура грузится, body = JSON.parse(raw), подпись test-secret сходится', () => {
	for (const name of NAMES) {
		const fx = fixture(name);
		expect(fx.body).toEqual(JSON.parse(fx.raw));
		expect(fx.headers['x-plane-signature']).toBe(
			createHmac('sha256', 'test-secret').update(fx.raw).digest('hex'),
		);
	}
});

test('x-plane-event доставки совпадает с event тела', () => {
	for (const name of NAMES.filter((n) => n.startsWith('plane-app-'))) {
		expect(fixture(name).headers['x-plane-event']).toBe(delivery(name).event);
	}
	expect(fixture('plane-comment-get-mention').headers['x-plane-event']).toBe('api:comment-get');
});

test('в фикстурах только UUID-подмены', () => {
	for (const name of NAMES) {
		const uuids = fixture(name).raw.match(
			/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
		);
		expect(uuids?.length ?? 0).toBeGreaterThan(0);
		for (const u of uuids ?? []) expect(u).toMatch(/^00000000-0000-4000-8000-\d{12}$/);
	}
});

test('бот один и тот же: автор созданной задачи, упомянутый в комментарии, agent_user_id run', () => {
	const run = delivery('plane-app-agent-run-create').data as {
		agent_user_id: string;
		comment_id: string;
		agent_run: { id: string; agent_user: string };
	};
	const bot = run.agent_user_id;
	expect(delivery('plane-app-workitem-created').activity.actor?.id).toBe(bot);
	expect(run.agent_run.agent_user).toBe(bot);
	const html = (delivery('plane-app-comment-mentions').data as { comment_html: string })
		.comment_html;
	const mentioned = [...html.matchAll(/entity_identifier="([^"]+)"/g)].map((m) => m[1]);
	expect(mentioned).toHaveLength(2);
	expect(mentioned[0]).toBe(bot);
	expect(mentioned[1]).not.toBe(bot);
	const got = fixture('plane-comment-get-mention').body as { id: string; comment_html: string };
	expect(got.id).toBe(run.comment_id);
	expect(got.comment_html).toBe(html);
});

test('двойная доставка комментария: тот же id, разное activity.field', () => {
	const first = delivery('plane-app-comment-mentions');
	const dup = delivery('plane-app-comment-mentions-dup');
	expect(dup.event).toBe(first.event);
	expect(dup.action).toBe(first.action);
	expect((dup.data as { id: string }).id).toBe((first.data as { id: string }).id);
	expect(first.activity.field).toBeNull();
	expect(dup.activity.field).toBe('description');
});

test('изменения задачи — машинный двойник: state_id и assignee_ids с UUID', () => {
	const done = delivery('plane-app-workitem-state-done');
	expect(done.activity.field).toBe('state_id');
	expect((done.data as { state: { group: string; id: string } }).state.group).toBe('completed');
	const assigned = delivery('plane-app-workitem-assigned');
	expect(assigned.activity.field).toBe('assignee_ids');
	expect(assigned.workspace_id).toBe(done.workspace_id);
});

// Whitelist of every string a committed fixture may carry (the repo is public). A value outside
// it is a leak or a new kind of field: look at it, then sanitize or add it here deliberately.
const U = '00000000-0000-4000-8000-\\d{12}';
const ALLOWED: RegExp[] = [
	new RegExp(`^${U}$`),
	/^(User|Name)\d+$/,
	/^user\d+@example\.com$/,
	/^example-[a-z-]+$/,
	/^plane\.example\.com$/,
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
	/^#[0-9A-Fa-f]{6}$/,
	/^(Backlog|Todo|In Progress|Done|Cancelled)$/,
	new RegExp(`^plane-discord probe ${U}$`),
	/^plane-discord-probe$/,
	/^api:comment-get$/,
	/^(issue|issue_comment|agent_run_create|agent_run|comment_thread|created|updated)$/,
	/^(assignee_ids|state_id|description|mention|in_progress|trigger_type|INTERNAL|none)$/,
	/^(backlog|completed|mention)$/,
	/^(<p><\/p>|test|)$/,
	// comment HTML: only the editor's wrapper, UUID attributes and the word "test"
	new RegExp(
		`^<p class="editor-paragraph-block" data-spacing-group="body" data-id="${U}">(<mention-component id="${U}" entity_identifier="${U}" entity_name="user_mention"></mention-component> )+test</p>$`,
	),
];
const allowed = (s: string): boolean => ALLOWED.some((re) => re.test(s));

function strings(node: unknown, path = '$'): [string, string][] {
	if (typeof node === 'string') return [[path, node]];
	if (Array.isArray(node)) return node.flatMap((x, i) => strings(x, `${path}[${i}]`));
	if (node !== null && typeof node === 'object') {
		return Object.entries(node).flatMap(([k, v]) => strings(v, `${path}.${k}`));
	}
	return [];
}

test('allowlist: ни одно строковое значение фикстур (включая raw) не вне белого списка', () => {
	for (const name of NAMES) {
		const fx = fixture(name);
		const outside = [...strings(fx.headers, 'headers'), ...strings(fx.body, 'raw')].filter(
			([path, v]) => path !== 'headers.x-plane-signature' && !allowed(v),
		);
		expect({ name, outside }).toEqual({ name, outside: [] });
	}
});

test('allowlist краснеет на реальном имени модуля и на чужой почте', () => {
	expect(allowed('M9 — real module name')).toBe(false);
	expect(allowed('ivan@corp.test')).toBe(false);
});
