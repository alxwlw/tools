// The real entry point in a child process: config from the environment, PORT, exit codes, SIGTERM.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');
const TENANTS = readFileTenants();

function readFileTenants(): string {
	return JSON.stringify({
		tenants: [
			{
				id: 'acme',
				guildId: '111111111111111111',
				workspace: 'example-ws',
				workspaceId: '00000000-0000-4000-8000-000000000001',
				plane: { clientId: 'example-client-id', appInstallationId: 'inst-1' },
				serviceChannelId: null,
				channels: [],
				users: [],
			},
		],
	});
}

function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
	const port = probe.port as number;
	void probe.stop(true);
	return port;
}

function spawn(overrides: Record<string, string | undefined> = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'plane-discord-'));
	writeFileSync(join(dir, 'tenants.json'), TENANTS);
	const port = freePort();
	const proc = Bun.spawn(['bun', ENTRY], {
		env: {
			PATH: process.env.PATH,
			PORT: String(port),
			PLANE_DISCORD_CONFIG: join(dir, 'tenants.json'),
			PLANE_DISCORD_DB: join(dir, 'state.sqlite'),
			// An address that refuses at once, so the background warm-up fails fast and offline.
			PLANE_DISCORD_PLANE_URL: 'http://127.0.0.1:1',
			PLANE_DISCORD_PUBLIC_URL: 'https://plane-discord.example.com',
			PLANE_DISCORD_DISCORD_APPLICATION_ID: '123456789012345678',
			PLANE_DISCORD_DISCORD_PUBLIC_KEY: 'ab'.repeat(32),
			PLANE_DISCORD_DISCORD_BOT_TOKEN: 'bot-token-value',
			PLANE_DISCORD_ACME_PLANE_SECRET: 'client-secret-value',
			PLANE_DISCORD_ACME_WEBHOOK_SECRET: 'webhook-secret-value',
			...overrides,
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { proc, port };
}

/** Reads the child's stdout until a line contains `needle`; returns everything read. */
async function untilLine(proc: ReturnType<typeof Bun.spawn>, needle: string): Promise<string> {
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let text = '';
	while (!text.includes(needle)) {
		const { value, done } = await reader.read();
		if (done) break;
		text += decoder.decode(value);
	}
	reader.releaseLock();
	return text;
}

const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill('SIGKILL');
});

describe('src/index.ts как процесс', () => {
	test('слушает PORT из окружения, /healthz отвечает ok, SIGTERM → выход с кодом 0', async () => {
		const { proc, port } = spawn();
		children.push(proc);
		const out = await untilLine(proc, '"event":"listening"');
		expect(out).toContain(`"port":${port}`);
		expect(out).toContain('"id":"acme"');
		const res = await fetch(`http://127.0.0.1:${port}/healthz`);
		expect(await res.text()).toBe('ok');
		proc.kill('SIGTERM');
		expect(await proc.exited).toBe(0);
	});

	test('SIGINT тоже останавливает чисто', async () => {
		const { proc } = spawn();
		children.push(proc);
		await untilLine(proc, '"event":"listening"');
		proc.kill('SIGINT');
		expect(await proc.exited).toBe(0);
	});

	test('плохой конфиг → код 1, в stderr имя переменной и ни одного секрета', async () => {
		const { proc } = spawn({ PLANE_DISCORD_ACME_WEBHOOK_SECRET: undefined });
		children.push(proc);
		expect(await proc.exited).toBe(1);
		const err = await new Response(proc.stderr as ReadableStream).text();
		expect(err).toContain('PLANE_DISCORD_ACME_WEBHOOK_SECRET');
		for (const secret of ['client-secret-value', 'bot-token-value'])
			expect(err).not.toContain(secret);
		expect(await new Response(proc.stdout as ReadableStream).text()).toBe('');
	});
});
