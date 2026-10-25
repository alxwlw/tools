import { describe, expect, test } from 'bun:test';
import { CHANNEL, DISCORD_ERR, DiscordApiError } from '../src/discord/rest.ts';
import { FakeDiscord } from './fake-discord.ts';

describe('FakeDiscord', () => {
	test('пишет вызовы по порядку; callsOf отдаёт аргументы одного метода', async () => {
		const fake = new FakeDiscord();
		await fake.sendMessage('c1', { content: 'a' });
		await fake.openDm('u1');
		await fake.sendMessage('c2', { content: 'b' });
		expect(fake.calls.map((c) => c.method)).toEqual(['sendMessage', 'openDm', 'sendMessage']);
		expect(fake.callsOf('sendMessage')).toEqual([
			['c1', { content: 'a' }],
			['c2', { content: 'b' }],
		]);
	});

	test('ошибка по методу: openDm → 403 / 50007, остальные методы работают', async () => {
		const fake = new FakeDiscord();
		fake.failures.set(
			'openDm',
			new DiscordApiError(403, 'POST', '/users/@me/channels', DISCORD_ERR.CANNOT_DM),
		);
		const err = (await fake.openDm('u1').catch((e: unknown) => e)) as DiscordApiError;
		expect([err.status, err.code]).toEqual([403, 50007]);
		expect(fake.calls).toHaveLength(1);
		expect((await fake.sendMessage('c1', { content: 'x' })).id).toBeString();
		expect(await fake.openDm('u1').catch(() => 'failed')).toBe('failed');
	});

	test('каналы с типами: getChannel, listGuildChannels по серверу, createForumPost добавляет пост', async () => {
		const fake = new FakeDiscord();
		fake.channels.set('f1', {
			id: 'f1',
			type: CHANNEL.FORUM,
			parentId: null,
			guildId: 'g1',
			name: 'forum',
		});
		fake.channels.set('x1', {
			id: 'x1',
			type: CHANNEL.TEXT,
			parentId: null,
			guildId: 'g2',
			name: 'other',
		});
		expect((await fake.getChannel('f1')).type).toBe(CHANNEL.FORUM);
		expect(await fake.getChannel('nope').catch((e: unknown) => String(e))).toContain('nope');
		const post = await fake.createForumPost('f1', 'title', { content: 'c' });
		expect(post.messageId).toBe(post.threadId);
		const inGuild = await fake.listGuildChannels('g1');
		expect(inGuild.map((c) => c.id).sort()).toEqual(['f1', post.threadId].sort());
		expect((await fake.getChannel(post.threadId)).parentId).toBe('f1');
	});
});
