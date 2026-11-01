// Adapted from apps/plane-miro/src/web.ts.
import { join } from 'node:path';

/** 'graph' → bundled browser JS. */
export type WebAssets = ReadonlyMap<string, string>;

const NAMES = ['graph'] as const;
const ASSET_HEADERS = {
	'content-type': 'text/javascript; charset=utf-8',
	'cache-control': 'no-cache',
	// The Plane HTML block has an opaque origin (`null`).
	'access-control-allow-origin': '*',
};

/** Bun.build of web/graph.ts, target 'browser', minify, no splitting; throws on a build error. */
export async function buildWeb(webDir: string): Promise<WebAssets> {
	const assets = new Map<string, string>();
	for (const name of NAMES) {
		// Throws on a build error: that is the failure signal.
		const result = await Bun.build({
			entrypoints: [join(webDir, `${name}.ts`)],
			target: 'browser',
			minify: true,
			splitting: false,
		});
		assets.set(name, await (result.outputs[0] as Blob).text());
	}
	return assets;
}

/** /assets/graph.js → the bundle; anything else → null. */
export function createWeb(assets: WebAssets): (url: URL) => Response | null {
	return (url) => {
		const name = url.pathname.match(/^\/assets\/([a-z]+)\.js$/)?.[1];
		const code = name === undefined ? undefined : assets.get(name);
		return code === undefined ? null : new Response(code, { headers: ASSET_HEADERS });
	};
}
