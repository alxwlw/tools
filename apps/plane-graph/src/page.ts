import { esc } from './html.ts';

// d3 is loaded in the browser, not bundled: the service has no runtime dependencies.
const D3 =
	'<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js" integrity="sha384-CjloA8y00+1SDAUkjs099PVfnY2KmDC2BZnws9kh8D/lX1s46w6EPhpXdqMfjK6i" crossorigin="anonymous"></script>';

type Urls = { scriptUrl: string; dataUrl: string };

const mount = (o: Urls) =>
	`<div id="graph"></div>\n${D3}\n<script src="${esc(o.scriptUrl)}" data-graph="${esc(o.dataUrl)}"></script>`;

/** The full "Граф задач" page; the addresses may be relative. */
export function graphPage(o: Urls): string {
	return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Граф задач</title>
<style>html,body{margin:0;height:100%}#graph{height:100%}</style>
</head>
<body>
${mount(o)}
</body>
</html>
`;
}

/** The shell for a Plane HTML block: the addresses must be absolute, the block's origin is opaque. */
export function planeBlock(o: Urls): string {
	return `<!doctype html>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
${mount(o)}
`;
}
