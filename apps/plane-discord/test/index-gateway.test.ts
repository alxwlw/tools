import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { SerialQueue } from '../src/queue.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from '../src/store.ts';
import { CHANNEL, ENV, GUILD, PROJECT, running, start, world } from './index-world.ts';

afterEach(async () => {
	for (const service of running.splice(0)) await service.stop();
});

describe('startService: Gateway', () => {
	test('startService поднимает и останавливает Gateway через внедрённую фабрику', async () => {
		const { w, service } = start();
		expect(w.gateways).toHaveLength(1);
		const g = w.gateways[0]!;
		expect(g.opts.token).toBe('bot-token-value');
		expect(g.opts.intents).toBe(1 | 512 | 32768);
		expect(g.started).toBe(1);
		expect(g.stopped).toBe(0);
		await service.stop();
		expect(g.stopped).toBe(1);
	});

	test('сообщение из Gateway привязанного треда → комментарий в Plane через очередь', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'idx-'));
		try {
			const db = join(dir, 'state.sqlite');
			const seed = new Store(db);
			seed.putThread('acme', 'w1', CHANNEL, '777777777777777771', PROJECT);
			seed.close();
			const { w, service } = start(world(), { ...ENV, PLANE_DISCORD_DB: db });
			w.gateways[0]!.opts.onMessage({
				id: '888888888888888881',
				channelId: '777777777777777771',
				guildId: GUILD,
				type: 0,
				content: 'из треда',
				author: { id: '555555555555555551', name: 'Мира', bot: false },
				webhookId: null,
				applicationId: null,
				attachments: [],
				mentions: [],
			});
			// The bot's own message in the same thread is not echoed back.
			w.gateways[0]!.opts.onMessage({
				id: '888888888888888882',
				channelId: '777777777777777771',
				guildId: GUILD,
				type: 0,
				content: 'эхо',
				author: { id: '123456789012345678', name: 'Plane', bot: true },
				webhookId: null,
				applicationId: '123456789012345678',
				attachments: [],
				mentions: [],
			});
			await service.idle();
			const posts = w.planeRequests.filter(
				(r) => r.method === 'POST' && r.path.endsWith('/comments/'),
			);
			expect(posts).toHaveLength(1);
			expect(JSON.parse(posts[0]!.body)).toMatchObject({
				external_source: 'discord',
				external_id: '888888888888888881',
			});
			expect(w.entries().some((e) => e.event === 'sync.done')).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test('gateway.fatal не останавливает HTTP-сервис', async () => {
		const { w, url } = start();
		w.gateways[0]!.opts.log({ event: 'gateway.fatal', level: 'error', code: 4014 });
		const res = await fetch(url('/healthz'));
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('ok');
	});

	test('сообщение вне привязанного треда не попадает в очередь', async () => {
		const push = spyOn(SerialQueue.prototype, 'push');
		try {
			const { w, service } = start();
			w.gateways[0]!.opts.onMessage({
				id: '888888888888888883',
				channelId: '777777777777777772',
				guildId: GUILD,
				type: 0,
				content: 'болтовня',
				author: { id: '555555555555555551', name: 'Мира', bot: false },
				webhookId: null,
				applicationId: null,
				attachments: [],
				mentions: [],
			});
			await service.idle();
			expect(push.mock.calls.filter(([label]) => String(label).startsWith('sync:'))).toEqual([]);
		} finally {
			push.mockRestore();
		}
	});
});
