/**
 * Spending of one top-level category, per subcategory and month, for finding what to cut.
 *
 * Wealthfolio's own reports have no monthly view of a subcategory and convert at one rate, so
 * this reads the amount the bank charged: a dollar bill stays in dollars.
 */

import { abs, add, type Dec, toNumber } from './decimal.ts';
import { arr, path, str } from './json.ts';

const MONTHS_BACK = 11;
const PAGE = 200;
const TAXONOMY = 'spending_categories';

export interface ReportSource {
	spendingCategories(): Promise<{ id: string; name: string; parentId?: string | null }[]>;
	searchCashActivities(request: {
		categoryIds: string[];
		activityTypes: string[];
		startDate: string;
		offset: number;
		limit: number;
	}): Promise<{ items: unknown[] }>;
}

interface Row {
	name: string;
	currency: string;
	byMonth: Map<string, Dec>;
	total: Dec;
}

export async function spendingReport(
	wf: ReportSource,
	category: string,
	now = new Date(),
): Promise<string> {
	const categories = await wf.spendingCategories();
	const tops = categories.filter((c) => !c.parentId);
	const top = tops.find((c) => c.name.toLowerCase() === category.toLowerCase());
	if (!top) {
		const names = tops.map((c) => c.name).join(', ');
		throw new Error(`No top-level category "${category}". There are: ${names}`);
	}
	const family = categories.filter((c) => c.id === top.id || c.parentId === top.id);
	const names = new Map(family.map((c) => [c.id, c.name]));

	const startDate = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - MONTHS_BACK, 1),
	).toISOString();
	const rows = new Map<string, Row>();
	for (let offset = 0; ; offset += PAGE) {
		const { items } = await wf.searchCashActivities({
			// The search doesn't roll a parent up to its children.
			categoryIds: family.map((c) => c.id),
			activityTypes: ['WITHDRAWAL'],
			startDate,
			offset,
			limit: PAGE,
		});
		for (const item of items) addCharge(rows, names, top.name, item);
		if (items.length < PAGE) break;
	}
	if (!rows.size) return `${top.name}: no charges in ${MONTHS_BACK + 1} months`;
	return format(top.name, [...rows.values()], now);
}

function addCharge(
	rows: Map<string, Row>,
	names: Map<string, string>,
	fallback: string,
	item: unknown,
): void {
	const assignment = arr(path(item, 'assignments')).find((a) => path(a, 'taxonomyId') === TAXONOMY);
	const name = names.get(str(path(assignment, 'categoryId')) ?? '') ?? fallback;
	const charged = str(path(item, 'metadata', 'operationAmount'));
	const amount = abs(charged ?? str(path(item, 'amount')) ?? '0');
	const currency =
		(charged && str(path(item, 'metadata', 'operationCurrency'))) ||
		(str(path(item, 'currency')) ?? '?');
	const month = (str(path(item, 'activityDate')) ?? '').slice(0, 7);

	const key = `${currency} ${name}`;
	const row: Row = rows.get(key) ?? {
		name,
		currency,
		byMonth: new Map<string, Dec>(),
		total: '0',
	};
	row.byMonth.set(month, add(row.byMonth.get(month) ?? '0', amount));
	row.total = add(row.total, amount);
	rows.set(key, row);
}

function format(title: string, rows: Row[], now: Date): string {
	const seen = rows.flatMap((r) => [...r.byMonth.keys()]);
	const months = monthsFrom(seen.sort()[0]!, now);
	const cells = (byMonth: Map<string, Dec>, total: Dec) => [
		...months.map((m) => (byMonth.has(m) ? money(byMonth.get(m)!) : '-')),
		money(total),
	];

	const table: string[][] = [['', '', ...months, 'Total']];
	for (const currency of [...new Set(rows.map((r) => r.currency))].sort()) {
		const group = rows
			.filter((r) => r.currency === currency)
			.sort((a, b) => toNumber(b.total) - toNumber(a.total));
		for (const r of group) table.push([r.name, currency, ...cells(r.byMonth, r.total)]);

		const byMonth = new Map<string, Dec>();
		let total: Dec = '0';
		for (const r of group) {
			for (const [m, v] of r.byMonth) byMonth.set(m, add(byMonth.get(m) ?? '0', v));
			total = add(total, r.total);
		}
		table.push(['Total', currency, ...cells(byMonth, total)]);
	}

	const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
	const render = (row: string[]) =>
		row.map((c, i) => (i < 2 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
	return [`${title}, by the month charged, in the currency charged`, ...table.map(render)].join(
		'\n',
	);
}

const money = (v: Dec) => toNumber(v).toFixed(2);

function monthsFrom(first: string, now: Date): string[] {
	const months: string[] = [];
	const last = now.toISOString().slice(0, 7);
	const [year, month] = first.split('-').map(Number) as [number, number];
	for (let i = 0; ; i++) {
		const m = new Date(Date.UTC(year, month - 1 + i, 1)).toISOString().slice(0, 7);
		months.push(m);
		if (m >= last) return months;
	}
}
