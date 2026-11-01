import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, test } from 'bun:test';

import { buildWeb, createWeb } from '../src/web.ts';

const dir = mkdtempSync(join(tmpdir(), 'plane-graph-web-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('web', () => {
	test('buildWeb собирает только graph из web/graph.ts', async () => {
		writeFileSync(join(dir, 'graph.ts'), 'console.log("marker-" + (1 + 1));\n');
		writeFileSync(join(dir, 'app.ts'), 'console.log("not-built");\n');
		const assets = await buildWeb(dir);
		expect([...assets.keys()]).toEqual(['graph']);
		expect(assets.get('graph')).toContain('marker-');
	});

	test('buildWeb падает на ошибке сборки', async () => {
		const bad = mkdtempSync(join(tmpdir(), 'plane-graph-web-bad-'));
		try {
			writeFileSync(join(bad, 'graph.ts'), 'const = ;\n');
			await expect(buildWeb(bad)).rejects.toThrow();
		} finally {
			rmSync(bad, { recursive: true, force: true });
		}
	});

	test('createWeb отдаёт только /assets/<имя>.js собранного', async () => {
		const serve = createWeb(new Map([['graph', 'code()']]));
		const res = serve(new URL('http://x/assets/graph.js?v=1'));
		expect(await res?.text()).toBe('code()');
		expect(serve(new URL('http://x/assets/app.js'))).toBeNull();
		expect(serve(new URL('http://x/graph.js'))).toBeNull();
		expect(serve(new URL('http://x/assets/graph.js/x'))).toBeNull();
	});
});
