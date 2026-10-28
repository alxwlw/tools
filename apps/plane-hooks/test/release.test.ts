import { beforeEach, describe, expect, test } from 'bun:test';
import {
	changelogHtml,
	publishRelease,
	type ReleaseDraft,
	releaseName,
	type ReleaseItem,
} from '../src/release.ts';
import { RELEASE_ITEMS_MAX } from '../src/plane.ts';
import { FakePlane } from './fake-plane.ts';

const SHA = '89abcdef0123456789abcdef0123456789abcdef';
const ONE = '1'.repeat(40);
const TWO = '2'.repeat(40);
const TITLE = 'release: staging → main — деплой через ветки окружений';

function draft(overrides: Partial<ReleaseDraft> = {}): ReleaseDraft {
	return {
		repository: 'example-org/app',
		sha: SHA,
		at: '2026-10-06T23:30:00.000Z',
		runUrl: 'https://github.com/example-org/app/actions/runs/37483709612',
		commits: [
			{ sha: SHA, message: `Merge pull request #830 from example-org/staging\n\n${TITLE}\n` },
			{ sha: ONE, message: 'feat(gateway): [OPS-12] faster fills (#829)\n\nbody' },
			{ sha: TWO, message: 'fix(settler): [MONO-3] <script>x</script> (#828)' },
		],
		...overrides,
	};
}

const ITEMS: ReleaseItem[] = [
	{ key: 'OPS-12', workItemId: 'w12' },
	{ key: 'MONO-3', workItemId: 'w3' },
	{ key: 'OPS-12', workItemId: 'w12' },
];

let plane: FakePlane;

beforeEach(() => {
	plane = new FakePlane();
});

describe('releaseName', () => {
	test('имя — дата UTC, sha7 и заголовок PR; без заголовка — дата и sha7', () => {
		expect(releaseName(draft({ headline: TITLE }))).toBe(`2026-10-06 · 89abcde — ${TITLE}`);
		expect(releaseName(draft())).toBe('2026-10-06 · 89abcde');
		expect(releaseName(draft({ headline: '  ' }))).toBe('2026-10-06 · 89abcde');
	});

	test('сообщение merge-коммита из staging больше не источник заголовка', () => {
		const message = `Merge pull request #830 from example-org/staging\n\n${TITLE}\n`;
		expect(releaseName(draft({ commits: [{ sha: SHA, message }] }))).toBe('2026-10-06 · 89abcde');
	});

	test('длинный заголовок обрезается до 200 символов с многоточием', () => {
		const long = 'я'.repeat(300);
		const name = releaseName(draft({ headline: long }));
		expect(Array.from(name)).toHaveLength(200);
		expect(name.endsWith('…')).toBe(true);
	});
});

describe('changelogHtml', () => {
	test('коммиты со ссылками и экранированием, затем задачи без повторов', () => {
		const commit = (sha: string) =>
			`<a href="https://github.com/example-org/app/commit/${sha}">${sha.slice(0, 7)}</a>`;
		expect(changelogHtml(draft(), ITEMS)).toBe(
			'<h3>Коммиты</h3><ul>' +
				`<li>${commit(SHA)} Merge pull request #830 from example-org/staging</li>` +
				`<li>${commit(ONE)} feat(gateway): [OPS-12] faster fills (#829)</li>` +
				`<li>${commit(TWO)} fix(settler): [MONO-3] &lt;script&gt;x&lt;/script&gt; (#828)</li>` +
				'</ul><h3>Задачи</h3><ul><li><code>OPS-12</code></li><li><code>MONO-3</code></li></ul>',
		);
	});

	test('заголовок коммита в changelog обрезается до 200 символов', () => {
		const long = 'я'.repeat(300);
		const html = changelogHtml(draft({ commits: [{ sha: ONE, message: `${long}\nbody` }] }), []);
		expect(html).toContain(` ${'я'.repeat(199)}…</li>`);
	});

	test('без коммитов и задач — одна строка о повторном деплое', () => {
		expect(changelogHtml(draft({ commits: [] }), [])).toBe(
			'<h3>Коммиты</h3><p>Новых коммитов нет: повторный деплой того же sha.</p>',
		);
	});
});

describe('publishRelease', () => {
	test('создаёт релиз: имя, статус, дата, external_id, changelog, задачи', async () => {
		const result = await publishRelease({ plane }, draft({ headline: TITLE }), ITEMS);
		expect(plane.releases).toHaveLength(1);
		const [release] = plane.releases;
		expect(result).toEqual({ action: 'created', releaseId: release?.id as string });
		expect(release).toMatchObject({
			name: `2026-10-06 · 89abcde — ${TITLE}`,
			status: 'released',
			release_date: '2026-10-06',
			external_source: 'github-deploy',
			external_id: `example-org/app@${SHA}`,
			changelog: changelogHtml(draft(), ITEMS),
			workItemIds: ['w12', 'w3'],
		});
	});

	test('повтор того же sha — второго релиза нет, action noop', async () => {
		await publishRelease({ plane }, draft(), ITEMS);
		const again = await publishRelease({ plane }, draft({ at: '2026-10-07T08:00:00.000Z' }), ITEMS);
		expect(plane.releases).toHaveLength(1);
		expect(again).toEqual({ action: 'noop', releaseId: plane.releases[0]?.id as string });
		expect(plane.releases[0]?.release_date).toBe('2026-10-06');
	});

	test('повтор после сбоя changelog достраивает тот же релиз', async () => {
		plane.failNext('updateReleaseChangelog');
		await expect(publishRelease({ plane }, draft(), ITEMS)).rejects.toThrow();
		expect(plane.releases).toHaveLength(1);
		expect(plane.releases[0]?.changelog).toBe('');
		expect(plane.releases[0]?.workItemIds).toEqual([]);

		expect(await publishRelease({ plane }, draft(), ITEMS)).toMatchObject({ action: 'noop' });
		expect(plane.releases).toHaveLength(1);
		expect(plane.releases[0]?.changelog).toBe(changelogHtml(draft(), ITEMS));
		expect(plane.releases[0]?.workItemIds).toEqual(['w12', 'w3']);
	});

	test('задач больше RELEASE_ITEMS_MAX — привязываются первые RELEASE_ITEMS_MAX, без RangeError', async () => {
		const many = Array.from({ length: RELEASE_ITEMS_MAX + 5 }, (_, i) => ({
			key: `OPS-${i}`,
			workItemId: `w${i}`,
		}));
		await publishRelease({ plane }, draft(), many);
		expect(plane.releases[0]?.workItemIds).toHaveLength(RELEASE_ITEMS_MAX);
		expect(plane.releases[0]?.workItemIds.at(-1)).toBe(`w${RELEASE_ITEMS_MAX - 1}`);
	});

	test('повтор того же sha без коммитов не стирает changelog', async () => {
		await publishRelease({ plane }, draft(), ITEMS);
		const before = plane.releases[0]?.changelog;
		expect(before).toContain('faster fills');
		const again = await publishRelease({ plane }, draft({ commits: [] }), []);
		expect(again).toMatchObject({ action: 'noop' });
		expect(plane.releases).toHaveLength(1);
		expect(plane.releases[0]?.changelog).toBe(before as string);
		expect(plane.releases[0]?.workItemIds).toEqual(['w12', 'w3']);
	});

	test('новый релиз без коммитов получает changelog с пометкой о повторе', async () => {
		await publishRelease({ plane }, draft({ commits: [] }), []);
		expect(plane.releases[0]?.changelog).toBe(changelogHtml(draft({ commits: [] }), []));
	});

	test('без задач — привязка не вызывается', async () => {
		await publishRelease({ plane }, draft(), []);
		expect(plane.calls).not.toContain('addReleaseWorkItems');
	});
});
