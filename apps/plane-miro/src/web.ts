import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 'app' | 'panel' | 'card' → bundled browser JS. */
export type WebAssets = ReadonlyMap<string, string>;

const NAMES = ['app', 'panel', 'card'] as const;
const PAGE_HEADERS = {
	'content-type': 'text/html; charset=utf-8',
	// Miro embeds the pages in its own frames; no X-Frame-Options, which would forbid it.
	'content-security-policy': 'frame-ancestors https://miro.com',
	'cache-control': 'no-store',
};
const ASSET_HEADERS = {
	'content-type': 'text/javascript; charset=utf-8',
	'cache-control': 'no-cache',
};

/** Bun.build of web/{app,panel,card}.ts, target 'browser', minify, no splitting; throws on a build error. */
export async function buildWeb(webDir: string): Promise<WebAssets> {
	const assets = new Map<string, string>();
	for (const name of NAMES) {
		const result = await Bun.build({
			entrypoints: [join(webDir, `${name}.ts`)],
			target: 'browser',
			minify: true,
			splitting: false,
		});
		if (!result.success || result.outputs.length !== 1)
			throw new Error(`web build failed: ${name}`);
		assets.set(name, await (result.outputs[0] as Blob).text());
	}
	return assets;
}

/** /miro/app|panel|card → web/<name>.html; /miro/assets/<name>.js → the bundle; anything else → null. */
export function createWeb(webDir: string, assets: WebAssets): (url: URL) => Response | null {
	const pages = new Map<string, string>(
		NAMES.map((name) => [name, readFileSync(join(webDir, `${name}.html`), 'utf8')]),
	);
	return (url) => {
		const asset = url.pathname.match(/^\/miro\/assets\/([a-z]+)\.js$/)?.[1];
		if (asset !== undefined) {
			const code = assets.get(asset);
			return code === undefined ? null : new Response(code, { headers: ASSET_HEADERS });
		}
		const page = url.pathname.match(/^\/miro\/([a-z]+)$/)?.[1];
		const html = page === undefined ? undefined : pages.get(page);
		return html === undefined ? null : new Response(html, { headers: PAGE_HEADERS });
	};
}
