import { esc } from '../html.ts';

/**
 * The Embed block of Plane's editor for a Miro place (design §10, probe 2026-10-26): Plane itself fetches
 * the oEmbed data when it shows the block, and the `moveToWidget` parameter of the URL survives.
 */
export function embedBlock(url: string, id: string = crypto.randomUUID()): string {
	return `<external-embed-component id="${id}" data-id="${id}" src="${esc(url)}" data-is-rich-card="false" data-has-embed-failed="false" data-has-tried-embedding="false" data-entity-name="Miro" data-entity-type="embed" data-spacing-group="container"></external-embed-component>`;
}
