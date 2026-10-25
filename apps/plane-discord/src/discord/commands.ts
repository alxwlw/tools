// Message commands of the current phase (phase 1: design §3 «1c»).
export const CREATE_COMMAND = 'Создать задачу в Plane';
export const APPEND_COMMAND = 'Добавить в задачу';

const MESSAGE_COMMAND = 3;
const GUILD_CONTEXT = 0;
const GUILD_INSTALL = 0;

/** Every command of the current phase: the body of a per-guild bulk overwrite. */
export function commandDefinitions(): unknown[] {
	return [CREATE_COMMAND, APPEND_COMMAND].map((name) => ({
		name,
		type: MESSAGE_COMMAND,
		contexts: [GUILD_CONTEXT],
		integration_types: [GUILD_INSTALL],
	}));
}
