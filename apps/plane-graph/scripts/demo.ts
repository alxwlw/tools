// Local look at the graph: `bun scripts/demo.ts`, then open http://localhost:8099/t/demo/graph?k=demo
// The data is invented (test/fixtures/demo-copy.json); nothing talks to a real Plane.
import { join } from 'node:path';

import type { Config } from '../src/config.ts';
import type { CopyData } from '../src/contract.ts';
import { createHandler } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { buildWeb } from '../src/web.ts';

const PORT = 8099;
const ROOT = join(import.meta.dir, '..');

const config: Config = {
	// Item links point back at this server, so a click opens a tab without leaving the machine.
	planeUrl: `http://localhost:${PORT}/plane-stub`,
	publicUrl: `http://localhost:${PORT}`,
	dbPath: ':memory:',
	port: PORT,
	tenants: new Map([
		[
			'demo',
			{
				id: 'demo',
				workspaceSlug: 'demo-ws',
				workspaceId: '00000000-0000-4000-8000-000000000001',
				clientId: 'demo-client',
				installationId: 'demo-installation',
				planeSecret: 'demo-plane-secret',
				webhookSecret: 'demo-webhook-secret',
				readKey: 'demo',
				agentKey: 'demo-agent-key',
			},
		],
	]),
};

const store = new Store(':memory:');
const copy = (await Bun.file(join(ROOT, 'test/fixtures/demo-copy.json')).json()) as CopyData;
const now = new Date();
store.replaceCopy('demo', copy, now.toISOString());
store.putRun(
	'demo',
	{
		runId: 'demo-run',
		kind: 'batch',
		startedAt: new Date(now.getTime() - 60_000).toISOString(),
		finishedAt: now.toISOString(),
		relationsAdded: [{ fromId: 'demo:INF-2', toId: 'demo:ABC-5' }],
		labelsAdded: [{ itemId: 'demo:ABC-5', label: 'код:api' }],
		skipped: 0,
		costUsd: null,
	},
	now.toISOString(),
);

const handler = createHandler({
	config,
	store,
	log: () => {},
	now: () => Date.now(),
	enqueue: () => {},
	assets: await buildWeb(join(ROOT, 'web')),
	acceptRun: () => Promise.resolve(true),
});

Bun.serve({ port: PORT, fetch: handler });
console.log(`demo: http://localhost:${PORT}/t/demo/graph?k=demo`);
