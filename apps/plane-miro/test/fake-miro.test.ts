import { describe, expect, test } from 'bun:test';
import { MiroApiError, MiroClient, type MiroApi } from '../src/miro/rest.ts';
import { FakeMiro } from './fake-miro.ts';

const B = 'uXjVb1=';
const card = { title: 'T', fields: [], status: 'connected' as const };
const place = { x: 0, y: 0, parentId: null };

const OPS: Record<string, (api: MiroApi) => Promise<unknown>> = {
	getBoard: (a) => a.getBoard(B),
	getItem: (a) => a.getItem(B, '1'),
	getFrameTitle: (a) => a.getFrameTitle(B, '1'),
	getItemTags: (a) => a.getItemTags(B, '1'),
	createAppCard: (a) => a.createAppCard(B, card, place),
	updateAppCard: (a) => a.updateAppCard(B, '1', { title: 'N' }),
	listConnectors: (a) => a.listConnectors(B),
	reattachConnector: (a) => a.reattachConnector(B, 'c1', 'end', '2'),
	deleteItem: (a) => a.deleteItem(B, '1'),
};
const ALL = Object.keys(OPS);

/** `stub` is what the real API answers for the situation; `setup` builds the same situation in the fake. */
const SCENARIOS: { name: string; stub: number; ops: string[]; setup: (f: FakeMiro) => void }[] = [
	{ name: 'доски нет (404)', stub: 404, ops: ALL, setup: () => {} },
	{
		name: 'доска без доступа (403)',
		stub: 403,
		ops: ALL,
		setup: (f) => {
			f.addBoard(B);
			f.noAccess.add(B);
		},
	},
	{
		name: 'элемента нет (404)',
		stub: 404,
		ops: ['getItem', 'getFrameTitle', 'getItemTags', 'deleteItem'],
		setup: (f) => void f.addBoard(B),
	},
	{
		name: 'карточки нет (404)',
		stub: 404,
		ops: ['updateAppCard'],
		setup: (f) => void f.addBoard(B),
	},
	{
		name: 'коннектора нет (404)',
		stub: 404,
		ops: ['reattachConnector'],
		setup: (f) => void f.addBoard(B),
	},
];

type Outcome = { value: string } | { status: number };
async function outcome(run: Promise<unknown>): Promise<Outcome> {
	try {
		return { value: JSON.stringify(await run) ?? 'undefined' };
	} catch (e) {
		if (e instanceof MiroApiError) return { status: e.status };
		throw e;
	}
}

describe('FakeMiro отвечает как MiroClient', () => {
	for (const sc of SCENARIOS) {
		for (const op of sc.ops) {
			test(`${sc.name}: ${op}`, async () => {
				const fake = new FakeMiro();
				sc.setup(fake);
				const client = new MiroClient({
					token: () => 'tok',
					fetch: async () => new Response('{}', { status: sc.stub }),
				});
				const [fromFake, fromClient] = await Promise.all([
					outcome(OPS[op]!(fake)),
					outcome(OPS[op]!(client)),
				]);
				expect(fromFake).toEqual(fromClient);
			});
		}
	}

	test('таблица не пуста: исходы разных операций различаются', async () => {
		const fake = new FakeMiro();
		expect(await outcome(fake.getItem(B, '1'))).toEqual({ value: 'null' });
		expect(await outcome(fake.getItemTags(B, '1'))).toEqual({ status: 404 });
	});

	test('updateAppCard: явный undefined не затирает поле', async () => {
		const fake = new FakeMiro();
		fake.addBoard(B);
		const id = await fake.createAppCard(B, card, place);
		await fake.updateAppCard(B, id, { title: undefined, status: 'disabled' });
		expect(fake.cardsOn(B)[0]!.card).toEqual({ title: 'T', fields: [], status: 'disabled' });
	});

	test('failNext бросает ошибку один раз, calls ведёт журнал', async () => {
		const fake = new FakeMiro();
		fake.failNext('tokenValid', new Error('boom'));
		await expect(fake.tokenValid()).rejects.toThrow('boom');
		expect(await fake.tokenValid()).toBe(true);
		expect(fake.calls).toEqual(['tokenValid', 'tokenValid']);
	});
});
