import { describe, expect, test } from 'bun:test';

import { type ReportSource, spendingReport } from '../src/report.ts';

const NOW = new Date('2026-03-15T12:00:00Z');
const CATEGORIES = [
	{ id: 'cat_infra', name: 'Infra', parentId: null },
	{ id: 'cat_infra_github', name: 'GitHub', parentId: 'cat_infra' },
	{ id: 'cat_infra_vercel', name: 'Vercel', parentId: 'cat_infra' },
	{ id: 'cat_groceries', name: 'Groceries', parentId: null },
];

const charge = (
	categoryId: string,
	date: string,
	amount: string,
	currency: string,
	operationAmount?: string,
	operationCurrency?: string,
) => ({
	activityType: 'WITHDRAWAL',
	activityDate: `${date}T10:00:00+00:00`,
	amount,
	currency,
	metadata: operationAmount ? { operationAmount, operationCurrency } : null,
	assignments: [{ taxonomyId: 'spending_categories', categoryId }],
});

function source(items: unknown[]): ReportSource & { requests: any[] } {
	const requests: any[] = [];
	return {
		requests,
		spendingCategories: async () => CATEGORIES,
		searchCashActivities: async (req: any) => {
			requests.push(req);
			return { items: items.slice(req.offset, req.offset + req.limit) };
		},
	};
}

const lines = (table: string) => table.split('\n').map((l) => l.trim().split(/\s{2,}/));

describe('spending report', () => {
	test('a row per vendor and currency, a column per month, totals per currency', async () => {
		const table = await spendingReport(
			source([
				charge('cat_infra_github', '2026-01-10', '168', 'UAH', '-4', 'USD'),
				charge('cat_infra_github', '2026-03-10', '170', 'UAH', '-4.5', 'USD'),
				charge('cat_infra_vercel', '2026-03-02', '840', 'UAH', '-20', 'USD'),
				charge('cat_infra_vercel', '2026-02-02', '500', 'UAH', '-500', 'UAH'),
			]),
			'Infra',
			NOW,
		);
		expect(lines(table)).toEqual([
			['Infra, by the month charged, in the currency charged'],
			['2026-01', '2026-02', '2026-03', 'Total'],
			['Vercel', 'UAH', '-', '500.00', '-', '500.00'],
			['Total', 'UAH', '-', '500.00', '-', '500.00'],
			['Vercel', 'USD', '-', '-', '20.00', '20.00'],
			['GitHub', 'USD', '4.00', '-', '4.50', '8.50'],
			['Total', 'USD', '4.00', '-', '24.50', '28.50'],
		]);
	});

	test('asks for each subcategory by id, since the search does not roll up a parent', async () => {
		const s = source([]);
		await spendingReport(s, 'infra', NOW);
		expect(s.requests[0].categoryIds).toEqual([
			'cat_infra',
			'cat_infra_github',
			'cat_infra_vercel',
		]);
		expect(s.requests[0].activityTypes).toEqual(['WITHDRAWAL']);
		expect(s.requests[0].startDate).toBe('2025-04-01T00:00:00.000Z');
	});

	test('an operation without the bank amount falls back to the account amount', async () => {
		const table = await spendingReport(
			source([charge('cat_infra_github', '2026-03-01', '168.5', 'UAH')]),
			'Infra',
			NOW,
		);
		expect(lines(table)[2]).toEqual(['GitHub', 'UAH', '168.50', '168.50']);
	});

	test('a charge filed on the parent itself gets a row under the parent name', async () => {
		const table = await spendingReport(
			source([charge('cat_infra', '2026-03-01', '10', 'USD')]),
			'Infra',
			NOW,
		);
		expect(lines(table)[2]).toEqual(['Infra', 'USD', '10.00', '10.00']);
	});

	test('reads every page', async () => {
		const items = Array.from({ length: 450 }, () =>
			charge('cat_infra_github', '2026-03-01', '1', 'USD'),
		);
		const s = source(items);
		const table = await spendingReport(s, 'Infra', NOW);
		expect(s.requests.length).toBe(3);
		expect(lines(table)[2]).toEqual(['GitHub', 'USD', '450.00', '450.00']);
	});

	test('months with no charges between two others stay in the table', async () => {
		const table = await spendingReport(
			source([
				charge('cat_infra_github', '2026-01-01', '1', 'USD'),
				charge('cat_infra_github', '2026-03-01', '1', 'USD'),
			]),
			'Infra',
			NOW,
		);
		expect(lines(table)[1]).toEqual(['2026-01', '2026-02', '2026-03', 'Total']);
	});

	test('no charges says so', async () => {
		expect(await spendingReport(source([]), 'Infra', NOW)).toBe('Infra: no charges in 12 months');
	});

	test('an unknown category names the ones there are', async () => {
		await expect(spendingReport(source([]), 'Nope', NOW)).rejects.toThrow(
			'No top-level category "Nope". There are: Infra, Groceries',
		);
	});
});
