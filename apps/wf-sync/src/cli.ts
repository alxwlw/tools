#!/usr/bin/env bun
/**
 * wf-sync — sync exchanges, wallets and banks into Wealthfolio.
 *
 *   wf-sync run      [--config config.yaml]   one sync, then exit
 *   wf-sync daemon   [--config config.yaml]   sync every interval_minutes
 *   wf-sync dry-run  [--config config.yaml]   fetch & print, write nothing
 *   wf-sync check    [--config config.yaml]   test each connector and the Wealthfolio login
 *   wf-sync report <category>                 what a top-level category cost, per subcategory and month
 */

import { parseArgs } from 'node:util';

import { loadConfig } from './config.ts';
import { buildConnectors, type RunSummary, SyncEngine } from './engine.ts';
import { sleep } from './http.ts';
import { errorMessage } from './json.ts';
import { createLogger, setLevel } from './log.ts';
import { spendingReport } from './report.ts';
import { State } from './state.ts';
import { WealthfolioClient } from './wealthfolio.ts';

const USAGE = `Usage: wf-sync <run|daemon|dry-run|check|report <category>> [--config path] [--verbose]`;

async function main(): Promise<number> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			config: { type: 'string', short: 'c', default: process.env.WF_SYNC_CONFIG ?? 'config.yaml' },
			verbose: { type: 'boolean', short: 'v', default: false },
			help: { type: 'boolean', short: 'h', default: false },
		},
		allowPositionals: true,
	});
	const command = positionals[0];
	if (values.help || !command) {
		console.log(USAGE);
		return values.help ? 0 : 1;
	}
	if (values.verbose) setLevel('debug');

	const log = createLogger();
	const config = await loadConfig(values.config);
	const state = new State(config.stateFile);
	const wf = new WealthfolioClient(
		config.wealthfolioUrl,
		config.wealthfolioPassword,
		log.child('wealthfolio'),
	);

	switch (command) {
		case 'check':
			return check();
		case 'report': {
			const category = positionals[1];
			if (!category) {
				console.error(USAGE);
				return 1;
			}
			await wf.login();
			console.log(await spendingReport(wf, category));
			return 0;
		}
		case 'dry-run': {
			const engine = new SyncEngine(config, state, wf, log);
			const built = await buildConnectors(config, state, log);
			const summary = await engine.run(built.connectors, { dryRun: true });
			summary.failed.unshift(...built.failed);
			report(summary, log);
			return summary.failed.length ? 2 : 0;
		}
		case 'run': {
			const summary = await runOnce();
			return summary.failed.length ? 2 : 0;
		}
		case 'daemon': {
			// Read through a function: the flag is flipped from a signal handler, which
			// control-flow narrowing can't see.
			let stop = false;
			const stopped = () => stop;
			const onSignal = () => {
				log.info('Stopping after the current run…');
				stop = true;
			};
			process.on('SIGTERM', onSignal);
			process.on('SIGINT', onSignal);
			log.info(`Daemon started, interval ${config.intervalMinutes} min`);
			while (!stopped()) {
				const started = Date.now();
				try {
					await runOnce();
				} catch (e) {
					log.error(`Run failed: ${errorMessage(e)}`);
				}
				const waitMs = Math.max(10_000, config.intervalMinutes * 60_000 - (Date.now() - started));
				for (let t = 0; t < waitMs && !stopped(); t += 1000) await sleep(1000);
			}
			return 0;
		}
		default:
			console.error(USAGE);
			return 1;
	}

	async function runOnce(): Promise<RunSummary> {
		const engine = new SyncEngine(config, state, wf, log);
		const built = await buildConnectors(config, state, log);
		const summary = await engine.run(built.connectors);
		summary.failed.unshift(...built.failed);
		report(summary, log);
		return summary;
	}

	async function check(): Promise<number> {
		let failed = 0;
		try {
			await wf.login();
			const accounts = await wf.listAccounts();
			log.info(`Wealthfolio OK (${config.wealthfolioUrl}), ${accounts.length} account(s)`);
		} catch (e) {
			failed++;
			log.error(`Wealthfolio: ${errorMessage(e)}`);
		}
		const built = await buildConnectors(config, state, log);
		failed += built.failed.length;
		for (const c of built.connectors) {
			try {
				log.info(`[${c.id}] OK — ${await c.check()}`);
			} catch (e) {
				failed++;
				log.error(`[${c.id}] ${errorMessage(e)}`);
			}
		}
		state.save();
		return failed ? 2 : 0;
	}
}

function report(s: RunSummary, log: ReturnType<typeof createLogger>): void {
	const failed = s.failed.length ? `; failed: ${s.failed.map((f) => f.id).join(', ')}` : '';
	log.info(
		`Done: ${s.ok.length} connector(s) ok, ${s.accounts} account(s) written, ${s.activities} activit(ies) imported, ` +
			`crypto+USD ≈ $${s.totalUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}${failed}`,
	);
}

main().then(
	(code) => process.exit(code),
	(e: unknown) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	},
);
