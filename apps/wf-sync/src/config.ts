/** YAML config with ${ENV_VAR} / ${ENV_VAR:-default} substitution so secrets can live in .env. */

import { dirname, isAbsolute, resolve } from 'node:path';

import { parse } from 'yaml';

import { arr, num, obj, str } from './json.ts';

export class ConfigError extends Error {}

export interface ConnectorConfig {
	id: string;
	type: string;
	name?: string;
	enabled: boolean;
	options: Record<string, unknown>;
}

export interface PricingConfig {
	/** Symbols that are always priced by wf-sync (MANUAL quotes), never by Yahoo. */
	manualSymbols: string[];
	/** Public exchanges whose tickers are used as a price fallback. */
	exchanges: string[];
}

export interface Config {
	wealthfolioUrl: string;
	wealthfolioPassword?: string;
	baseCurrency: string;
	intervalMinutes: number;
	stateFile: string;
	minValueUsd: number;
	stablecoinsAsCash: boolean;
	pluginsDir?: string;
	pricing: PricingConfig;
	connectors: ConnectorConfig[];
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;

export function expandEnv(
	value: unknown,
	env: Record<string, string | undefined> = process.env,
): unknown {
	if (typeof value === 'string') {
		return value.replace(ENV_RE, (_m, name: string, def?: string) => {
			const v = env[name];
			if (v !== undefined) return v;
			if (def !== undefined) return def;
			throw new ConfigError(`Environment variable ${name} is not set`);
		});
	}
	if (Array.isArray(value)) return value.map((v) => expandEnv(v, env));
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)]));
	}
	return value;
}

const RESERVED = new Set(['id', 'type', 'name', 'enabled']);

export function parseConfig(text: string, baseDir: string, env = process.env): Config {
	const raw = obj(expandEnv(parse(text) ?? {}, env));
	const wf = obj(raw.wealthfolio);
	const url = (str(wf.url) ?? '').replace(/\/+$/, '');
	if (!url) throw new ConfigError('wealthfolio.url is required');

	const seen = new Set<string>();
	const connectors: ConnectorConfig[] = arr(raw.connectors).map((item, i) => {
		const c = obj(item);
		const type = str(c.type);
		if (!type) throw new ConfigError(`connectors[${i}]: 'type' is required`);
		const id = str(c.id) ?? type;
		if (seen.has(id)) throw new ConfigError(`Duplicate connector id: ${id}`);
		seen.add(id);
		return {
			id,
			type,
			name: str(c.name) || undefined,
			enabled: c.enabled !== false,
			options: Object.fromEntries(Object.entries(c).filter(([k]) => !RESERVED.has(k))),
		};
	});

	const abs = (p: string) => (isAbsolute(p) ? p : resolve(baseDir, p));
	const pricing = obj(raw.pricing);
	const exchanges = arr(pricing.exchanges)
		.map(str)
		.filter((x): x is string => Boolean(x));
	const pluginsDir = str(raw.plugins_dir);

	return {
		wealthfolioUrl: url,
		wealthfolioPassword: str(wf.password) || undefined,
		baseCurrency: (str(raw.base_currency) ?? 'USD').toUpperCase(),
		intervalMinutes: num(raw.interval_minutes) ?? 60,
		stateFile: abs(str(raw.state_file) ?? 'state.json'),
		minValueUsd: num(raw.min_value_usd) ?? 1,
		stablecoinsAsCash: raw.stablecoins_as_cash !== false,
		pluginsDir: pluginsDir ? abs(pluginsDir) : undefined,
		pricing: {
			manualSymbols: arr(pricing.manual_symbols)
				.map(str)
				.filter((x): x is string => Boolean(x))
				.map((x) => x.toUpperCase()),
			exchanges: exchanges.length ? exchanges : ['binance', 'okx', 'kraken'],
		},
		connectors,
	};
}

export async function loadConfig(path: string): Promise<Config> {
	const file = Bun.file(path);
	if (!(await file.exists())) throw new ConfigError(`Config file not found: ${path}`);
	return parseConfig(await file.text(), dirname(resolve(path)));
}
