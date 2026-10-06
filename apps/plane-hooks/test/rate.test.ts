import { describe, expect, test } from "bun:test";
import { SlidingWindow } from "../src/rate.ts";

/** Fake clock: sleep advances time instantly and records how long it was asked to wait. */
function clock() {
	let t = 0;
	const sleeps: number[] = [];
	return {
		now: () => t,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			if (sleeps.length > 3) throw new Error("sleep storm");
			t += ms;
		},
		advance: (ms: number) => {
			t += ms;
		},
		sleeps,
	};
}

describe("SlidingWindow", () => {
	test("до max запросов в окне проходят без ожидания", async () => {
		const c = clock();
		const window = new SlidingWindow({ max: 3, windowMs: 1000, now: c.now, sleep: c.sleep });
		await Promise.all([window.acquire(), window.acquire(), window.acquire()]);
		expect(c.sleeps).toEqual([]);
	});

	test("запрос сверх max ждёт ровно до выхода самого старого из окна", async () => {
		const c = clock();
		const window = new SlidingWindow({ max: 2, windowMs: 1000, now: c.now, sleep: c.sleep });
		await window.acquire(); // t=0
		c.advance(300);
		await window.acquire(); // t=300
		await window.acquire(); // окно [0, 300] полно → ждёт до 1000
		expect(c.sleeps).toEqual([700]);
		await window.acquire(); // окно [300, 1000] полно → ждёт до 1300
		expect(c.sleeps).toEqual([700, 300]);
	});

	test("FIFO: поздний вызов не обгоняет ранний, даже если окно освободилось к его приходу", async () => {
		const c = clock();
		const window = new SlidingWindow({ max: 1, windowMs: 1000, now: c.now, sleep: c.sleep });
		const order: string[] = [];
		await Promise.all(["a", "b", "c"].map((name) => window.acquire().then(() => order.push(name))));
		expect(order).toEqual(["a", "b", "c"]);
		expect(c.sleeps).toEqual([1000, 1000]);
	});

	test("граница окна: стамп ровно windowMs назад вытесняется без ожидания", async () => {
		const c = clock();
		const window = new SlidingWindow({ max: 1, windowMs: 1000, now: c.now, sleep: c.sleep });
		await window.acquire(); // t=0
		c.advance(1000);
		await window.acquire();
		expect(c.sleeps).toEqual([]);
	});

	test("отказ sleep не ломает очередь для следующих", async () => {
		const c = clock();
		let failOnce = true;
		const window = new SlidingWindow({
			max: 1,
			windowMs: 1000,
			now: c.now,
			sleep: async (ms) => {
				if (failOnce) {
					failOnce = false;
					throw new Error("sleep failed");
				}
				await c.sleep(ms);
			},
		});
		await window.acquire();
		await expect(window.acquire()).rejects.toThrow("sleep failed");
		await window.acquire();
		expect(c.sleeps).toEqual([1000]);
	});
});
