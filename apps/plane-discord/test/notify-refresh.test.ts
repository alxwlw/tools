// A project or state created after the cache was loaded: the lookup refreshes past the cache once, then gives up.
import { describe, expect, test } from 'bun:test';

import type { Tenant } from '../src/config.ts';
import { CHANNEL, type OutMessage } from '../src/discord/rest.ts';
import type { LogEntry } from '../src/log.ts';
import { createNotifier, type Delivery, type TenantRuntime } from '../src/notify.ts';
import type { ProjectSummary, StateSummary } from '../src/plane/client.ts';
import type { PlaneEvent } from '../src/plane/webhook.ts';
import { Store } from '../src/store.ts';
import { userMap } from '../src/text.ts';
import { FakeDiscord } from './fake-discord.ts';
import { FakePlane } from './fake-plane.ts';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PROJECT = ID(1);
const ITEM = ID(100);
const S_STARTED = ID(31);
const S_DONE = ID(32);
const TEXT = '130000000000000002';
const GUILD = '120000000000000001';
const project: ProjectSummary = { id: PROJECT, identifier: 'LAB', name: 'Lab' };
const started: StateSummary = { id: S_STARTED, name: 'In Progress', group: 'started' };
const done: StateSummary = { id: S_DONE, name: 'Done', group: 'completed' };
const tenant: Tenant = {
	id: 'initech',
	guildId: GUILD,
	workspace: 'example-ws',
	workspaceId: ID(900),
	auth: { clientId: 'client', clientSecret: 'secret', appInstallationId: ID(901) },
	webhookSecret: 'hook',
	serviceChannelId: null,
	silenceHours: 72,
	hiddenProjects: [],
	channels: [
		{
			channelId: TEXT,
			projectId: PROJECT,
			moduleId: null,
			events: ['created', 'closed', 'mention'],
		},
	],
	users: [],
};

/** `stale` is what the cache holds; `fresh` is what Plane answers once the cache is bypassed. */
function world(opts: { staleProjects: ProjectSummary[]; freshProjects: ProjectSummary[] }) {
	const plane = new FakePlane();
	plane.items.set(ITEM, {
		id: ITEM,
		projectId: PROJECT,
		sequenceId: 41,
		name: 'Название',
		stateId: S_STARTED,
		assignees: [],
		priority: 'none',
		descriptionHtml: null,
	});
	plane.members = [{ id: ID(12), displayName: 'Carol' }];
	const discord = new FakeDiscord();
	discord.channels.set(TEXT, {
		id: TEXT,
		type: CHANNEL.TEXT,
		parentId: null,
		guildId: GUILD,
		name: 'c',
	});
	const asked = { projects: [] as boolean[], states: [] as boolean[] };
	let staleStates: StateSummary[] = [started];
	const freshStates: StateSummary[] = [started, done];
	const runtime: TenantRuntime = {
		tenant,
		plane,
		users: userMap([]),
		projects: async (o) => {
			asked.projects.push(o?.refresh === true);
			return o?.refresh ? opts.freshProjects : opts.staleProjects;
		},
		states: async (_p, o) => {
			asked.states.push(o?.refresh === true);
			return o?.refresh ? freshStates : staleStates;
		},
		members: async () => plane.members,
	};
	const logs: LogEntry[] = [];
	const notify = createNotifier({
		runtimes: new Map([['initech', runtime]]),
		discord,
		store: new Store(':memory:'),
		planeUrl: 'https://plane.example.com',
		channelType: async () => CHANNEL.TEXT,
		log: (e) => logs.push(e),
	});
	return {
		notify,
		discord,
		plane,
		asked,
		logs,
		setStaleStates: (s: StateSummary[]) => (staleStates = s),
	};
}
const snapshot = (stateId = S_STARTED) => ({
	id: ITEM,
	projectId: PROJECT,
	sequenceId: 41,
	name: 'Название',
	stateId,
	assignees: [],
	descriptionHtml: null,
});
const created: PlaneEvent = {
	kind: 'workitem.created',
	tenant: 'initech',
	eventKey: 'issue.created:x',
	actorId: ID(12),
	item: snapshot(),
};
const closed: PlaneEvent = {
	kind: 'workitem.updated',
	tenant: 'initech',
	eventKey: 'issue.updated:x',
	actorId: ID(12),
	item: snapshot(S_DONE),
	previous: { stateId: S_STARTED },
};
const mention: PlaneEvent = {
	kind: 'agent.mention',
	tenant: 'initech',
	eventKey: 'agent_run:r1',
	projectId: PROJECT,
	workItemId: ITEM,
	commentId: null,
	runId: ID(300),
};
const runAll = async (deliveries: Delivery[]) => {
	for (const d of deliveries) await d.run();
};
const texts = (discord: FakeDiscord) =>
	(discord.callsOf('sendMessage') as Array<[string, OutMessage]>).map(([, m]) => m.content);

describe('кэш проектов и состояний: обновление при промахе', () => {
	test('проект есть в кэше → в обход кэша не спрашиваем', async () => {
		const { notify, discord, asked } = world({
			staleProjects: [project],
			freshProjects: [project],
		});
		await runAll(await notify(created));
		expect(asked.projects).toEqual([false]);
		expect(texts(discord)).toHaveLength(1);
	});

	test('проекта нет в кэше, но он появился в Plane → второй запрос в обход кэша, доставка есть', async () => {
		const { notify, discord, asked } = world({ staleProjects: [], freshProjects: [project] });
		await runAll(await notify(created));
		expect(asked.projects).toEqual([false, true]);
		expect(texts(discord)[0]).toContain('**LAB-41** Название');
	});

	test('проекта нет и после обновления → ровно один повтор и notify.skip unknown_project', async () => {
		const { notify, discord, asked, logs } = world({ staleProjects: [], freshProjects: [] });
		expect(await notify(created)).toEqual([]);
		expect(asked.projects).toEqual([false, true]);
		expect(discord.calls).toEqual([]);
		expect(logs).toContainEqual({
			event: 'notify.skip',
			level: 'error',
			tenant: 'initech',
			reason: 'unknown_project',
			eventKey: 'issue.created:x',
		});
	});

	test('упоминание бота: проект появился после загрузки кэша → ответ про Discord, а не «проект не найден»', async () => {
		const { notify, plane, asked } = world({ staleProjects: [], freshProjects: [project] });
		await runAll(await notify(mention));
		expect(asked.projects).toEqual([false, true]);
		expect(plane.activities).toEqual([{ runId: ID(300), body: `→ Discord: ${TEXT}` }]);
	});

	test('состояние создано после загрузки → закрытие замечено после обновления', async () => {
		const { notify, discord, asked } = world({
			staleProjects: [project],
			freshProjects: [project],
		});
		await runAll(await notify(closed));
		expect(asked.states).toEqual([false, true]);
		expect(texts(discord)[0]).toContain('Задача закрыта');
	});

	test('состояние есть в кэше → в обход кэша не спрашиваем', async () => {
		const { notify, asked, setStaleStates } = world({
			staleProjects: [project],
			freshProjects: [project],
		});
		setStaleStates([started, done]);
		await notify(closed);
		expect(asked.states).toEqual([false]);
	});

	test('состояния нет и после обновления → notify.skip unknown_state, один повтор', async () => {
		const { notify, asked, logs } = world({ staleProjects: [project], freshProjects: [project] });
		expect(await notify({ ...closed, item: snapshot(ID(77)) } as PlaneEvent)).toEqual([]);
		expect(asked.states).toEqual([false, true]);
		expect(logs).toContainEqual({
			event: 'notify.skip',
			level: 'error',
			tenant: 'initech',
			reason: 'unknown_state',
			eventKey: 'issue.updated:x',
		});
	});
});
