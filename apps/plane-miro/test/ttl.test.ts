// Copy of apps/plane-discord/test/ttl.test.ts; keep in sync with src/ttl.ts.
import { describe, expect, test } from 'bun:test';
import { ttl } from '../src/ttl.ts';

describe('ttl', () => {
	test('в пределах TTL загрузчик вызывается один раз, после — снова', async () => {
		let clock = 0;
		let loads = 0;
		const get = ttl(
			async () => ++loads,
			1000,
			() => clock,
		);
		expect(await get()).toBe(1);
		clock = 999;
		expect(await get()).toBe(1);
		clock = 1000;
		expect(await get()).toBe(2);
	});

	test('ошибка загрузки не кэшируется', async () => {
		let loads = 0;
		const get = ttl(async () => {
			loads++;
			if (loads === 1) throw new Error('plane down');
			return 'ok';
		}, 60_000);
		await get().catch(() => undefined);
		expect(await get()).toBe('ok');
		expect(loads).toBe(2);
	});

	test('одновременные вызовы делят одну загрузку', async () => {
		let loads = 0;
		let release: (value: string) => void = () => undefined;
		const get = ttl(() => {
			loads++;
			return new Promise<string>((resolve) => {
				release = resolve;
			});
		}, 60_000);
		const both = Promise.all([get(), get()]);
		release('v');
		expect(await both).toEqual(['v', 'v']);
		expect(loads).toBe(1);
	});
});
