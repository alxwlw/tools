import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWeb, createWeb, type WebAssets } from '../src/web.ts';

const webDir = join(import.meta.dir, '../web');
let assets: WebAssets;
let web: (url: URL) => Response | null;

beforeAll(async () => {
	assets = await buildWeb(webDir);
	web = createWeb(webDir, assets);
});

describe('страницы', () => {
	for (const name of ['app', 'panel', 'card']) {
		test(`/miro/${name}: CSP frame-ancestors miro.com, без X-Frame-Options, SDK и свой бандл подключены`, async () => {
			const res = web(new URL(`http://x/miro/${name}`)) as Response;
			expect(res.status).toBe(200);
			expect(res.headers.get('content-security-policy')).toBe('frame-ancestors https://miro.com');
			expect(res.headers.get('x-frame-options')).toBeNull();
			expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
			expect(res.headers.get('cache-control')).toBe('no-store');
			const html = await res.text();
			expect(html).toContain('<script src="https://miro.com/app/static/sdk/v2/miro.js"></script>');
			expect(html).toContain(`<script type="module" src="/miro/assets/${name}.js"></script>`);
		});
	}

	test('страница панели несёт кнопки и поля, на которые опирается скрипт', async () => {
		const html = await (web(new URL('http://x/miro/panel')) as Response).text();
		for (const id of ['project', 'count', 'convert', 'query', 'hits', 'bind', 'status'])
			expect(html).toContain(`id="${id}"`);
	});
});

describe('бандлы', () => {
	test('собраны и не тянут bun: и node:', () => {
		for (const name of ['app', 'panel', 'card']) {
			const code = assets.get(name);
			expect(code?.length).toBeGreaterThan(100);
			expect(code).not.toMatch(/from ?["'](bun|node):/);
			// minified: one line
			expect(code?.trim()).not.toContain('\n');
		}
	});

	test('/miro/assets/<name>.js: javascript, no-cache, тот же код', async () => {
		const res = web(new URL('http://x/miro/assets/panel.js')) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
		expect(res.headers.get('cache-control')).toBe('no-cache');
		expect(await res.text()).toBe(assets.get('panel') ?? '');
		expect(await (web(new URL('http://x/miro/assets/app.js')) as Response).text()).toBe(
			assets.get('app') ?? '',
		);
	});

	test('панель зовёт API и отправляет пакеты, модалка — карточку', () => {
		expect(assets.get('panel')).toContain('/miro/api/convert');
		expect(assets.get('panel')).toContain('/miro/api/bind');
		expect(assets.get('card')).toContain('/miro/api/card');
		expect(assets.get('app')).toContain('/miro/panel');
	});

	test('ошибка сборки — исключение, а не пустой бандл', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'plane-miro-web-'));
		try {
			for (const name of ['app', 'panel', 'card'])
				writeFileSync(join(dir, `${name}.ts`), 'const = ;');
			await expect(buildWeb(dir)).rejects.toThrow();
		} finally {
			rmSync(dir, { recursive: true });
		}
	});
});

describe('маршрутизация', () => {
	test('неизвестный путь и неизвестный бандл → null', () => {
		expect(web(new URL('http://x/miro/zzz'))).toBeNull();
		expect(web(new URL('http://x/miro/assets/zzz.js'))).toBeNull();
		expect(web(new URL('http://x/miro/assets/panel.css'))).toBeNull();
		expect(web(new URL('http://x/miro/panel/'))).toBeNull();
		expect(web(new URL('http://x/miro/assets/constructor.js'))).toBeNull();
	});
});
