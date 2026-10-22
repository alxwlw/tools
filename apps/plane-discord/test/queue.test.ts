import { describe, expect, test } from 'bun:test';
import { isRetryable, SerialQueue, type QueueLog } from '../src/queue.ts';

type Entry = Parameters<QueueLog>[0];
const statusError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function setup() {
	const logs: Entry[] = [];
	const sleeps: number[] = [];
	const queue = new SerialQueue({
		log: (e) => logs.push(e),
		sleep: async (ms) => {
			sleeps.push(ms);
			if (sleeps.length > 10) throw new Error('sleep storm');
		},
	});
	return { queue, logs, sleeps };
}

describe('SerialQueue', () => {
	test('задачи идут по одной и в порядке push', async () => {
		const { queue } = setup();
		const order: string[] = [];
		let active = 0;
		let maxActive = 0;
		for (const name of ['a', 'b', 'c']) {
			queue.push(name, async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await Promise.resolve();
				await Promise.resolve();
				order.push(name);
				active--;
			});
		}
		await queue.idle();
		expect(order).toEqual(['a', 'b', 'c']);
		expect(maxActive).toBe(1);
		expect(queue.size).toBe(0);
	});

	test('status 503 — повторы с задержками 1000, 5000, 30000, затем один job.dropped', async () => {
		const { queue, logs, sleeps } = setup();
		let calls = 0;
		queue.push('flaky', async () => {
			calls++;
			throw statusError(503);
		});
		await queue.idle();
		expect(calls).toBe(4);
		expect(sleeps).toEqual([1000, 5000, 30000]);
		expect(logs).toEqual([
			{ event: 'job.retry', label: 'flaky', attempt: 1, error: 'HTTP 503' },
			{ event: 'job.retry', label: 'flaky', attempt: 2, error: 'HTTP 503' },
			{ event: 'job.retry', label: 'flaky', attempt: 3, error: 'HTTP 503' },
			{ event: 'job.dropped', label: 'flaky', attempt: 4, error: 'HTTP 503' },
		]);
	});

	test('status 404 — без повтора, job.dropped, следующая задача выполняется', async () => {
		const { queue, logs, sleeps } = setup();
		let bad = 0;
		let next = 0;
		queue.push('gone', async () => {
			bad++;
			throw statusError(404);
		});
		queue.push('after', async () => {
			next++;
		});
		await queue.idle();
		expect(bad).toBe(1);
		expect(next).toBe(1);
		expect(sleeps).toEqual([]);
		expect(logs).toEqual([{ event: 'job.dropped', label: 'gone', attempt: 1, error: 'HTTP 404' }]);
	});

	test('успех со второй попытки — один job.retry, без job.dropped', async () => {
		const { queue, logs, sleeps } = setup();
		let calls = 0;
		queue.push('once', async () => {
			calls++;
			if (calls === 1) throw statusError(429);
		});
		await queue.idle();
		expect(calls).toBe(2);
		expect(sleeps).toEqual([1000]);
		expect(logs).toEqual([{ event: 'job.retry', label: 'once', attempt: 1, error: 'HTTP 429' }]);
	});

	test('без sleep — настоящая задержка по умолчанию: 503, затем успех — один job.retry, без job.dropped', async () => {
		const logs: Entry[] = [];
		const queue = new SerialQueue({ log: (e) => logs.push(e), delaysMs: [20] });
		let calls = 0;
		queue.push('real', async () => {
			calls++;
			if (calls === 1) throw statusError(503);
		});
		const t0 = Date.now();
		await queue.idle();
		expect(Date.now() - t0).toBeGreaterThanOrEqual(15);
		expect(calls).toBe(2);
		expect(logs).toEqual([{ event: 'job.retry', label: 'real', attempt: 1, error: 'HTTP 503' }]);
	});

	test('log бросает на job.retry — следующая задача всё равно выполняется, idle резолвится', async () => {
		const queue = new SerialQueue({
			log: () => {
				throw new Error('log down');
			},
			sleep: async () => {},
		});
		let aCalls = 0;
		let bRan = false;
		queue.push('a', async () => {
			if (++aCalls === 1) throw statusError(503);
		});
		queue.push('b', async () => {
			bRan = true;
		});
		await queue.idle();
		expect(aCalls).toBe(2);
		expect(bRan).toBe(true);
		expect(queue.size).toBe(0);
	});

	test('счётчик попыток не переносится на следующую задачу', async () => {
		const { queue, logs } = setup();
		const calls = { a: 0, b: 0 };
		queue.push('a', async () => {
			if (++calls.a === 1) throw statusError(500);
		});
		queue.push('b', async () => {
			if (++calls.b === 1) throw statusError(500);
		});
		await queue.idle();
		expect(logs.map((l) => [l.label, l.attempt])).toEqual([
			['a', 1],
			['b', 1],
		]);
	});

	test('idle без задач разрешается сразу; push после idle снова запускает очередь', async () => {
		const { queue } = setup();
		await queue.idle();
		let ran = 0;
		queue.push('x', async () => {
			ran++;
		});
		await queue.idle();
		queue.push('y', async () => {
			ran++;
		});
		await queue.idle();
		expect(ran).toBe(2);
	});

	test('синхронный throw из задачи не ломает очередь', async () => {
		const { queue, logs } = setup();
		let ran = false;
		queue.push('sync', (() => {
			throw new Error('boom');
		}) as () => Promise<void>);
		queue.push('ok', async () => {
			ran = true;
		});
		await queue.idle();
		expect(ran).toBe(true);
		expect(logs).toEqual([{ event: 'job.dropped', label: 'sync', attempt: 1, error: 'boom' }]);
	});
});

describe('SerialQueue: размер и ожидание', () => {
	test('size считает выполняющуюся и ожидающие; idle не разрешается, пока задача идёт', async () => {
		const { queue } = setup();
		let release: () => void = () => {};
		queue.push('slow', () => new Promise<void>((resolve) => (release = resolve)));
		queue.push('next', async () => {});
		expect(queue.size).toBe(2);
		let idled = false;
		const waiting = queue.idle().then(() => (idled = true));
		await Promise.resolve();
		expect(idled).toBe(false);
		release();
		await waiting;
		expect(queue.size).toBe(0);
	});
});

describe('isRetryable', () => {
	test('5xx, 429, TypeError, TimeoutError, AbortError — да', () => {
		expect(isRetryable(statusError(500))).toBe(true);
		expect(isRetryable(statusError(599))).toBe(true);
		expect(isRetryable(statusError(429))).toBe(true);
		expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
		expect(isRetryable(new DOMException('t', 'TimeoutError'))).toBe(true);
		expect(isRetryable(new DOMException('a', 'AbortError'))).toBe(true);
	});

	test('4xx, обычная ошибка, не-объект — нет', () => {
		expect(isRetryable(statusError(499))).toBe(false);
		expect(isRetryable(statusError(400))).toBe(false);
		expect(isRetryable(new Error('x'))).toBe(false);
		expect(isRetryable('str')).toBe(false);
		expect(isRetryable(null)).toBe(false);
		expect(isRetryable(undefined)).toBe(false);
	});
});
