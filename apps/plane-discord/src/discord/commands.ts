// Commands of the current phase: message commands (phase 1, design §3 «1c») `/plane KEY` (phase 2) and `/plane-link KEY` (phase 3).
export const CREATE_COMMAND = 'Создать задачу в Plane';
export const APPEND_COMMAND = 'Добавить в задачу';
export const PLANE_COMMAND = 'plane';
export const PLANE_LINK_COMMAND = 'plane-link';
export const PLANE_KEY_OPTION = 'key';

const CHAT_INPUT_COMMAND = 1;
const MESSAGE_COMMAND = 3;
const STRING_OPTION = 3;
const GUILD_CONTEXT = 0;
const GUILD_INSTALL = 0;

/** Every command of the current phase: the body of a per-guild bulk overwrite. */
export function commandDefinitions(): unknown[] {
	const messageCommands = [CREATE_COMMAND, APPEND_COMMAND].map((name) => ({
		name,
		type: MESSAGE_COMMAND,
		contexts: [GUILD_CONTEXT],
		integration_types: [GUILD_INSTALL],
	}));
	return [
		...messageCommands,
		{
			name: PLANE_COMMAND,
			type: CHAT_INPUT_COMMAND,
			description: 'Карточка задачи Plane',
			options: [
				{
					name: PLANE_KEY_OPTION,
					type: STRING_OPTION,
					description: 'Ключ задачи, например LAB-40',
					required: true,
				},
			],
			contexts: [GUILD_CONTEXT],
			integration_types: [GUILD_INSTALL],
		},
		{
			name: PLANE_LINK_COMMAND,
			type: CHAT_INPUT_COMMAND,
			description: 'Привязать тред к задаче Plane',
			options: [
				{
					name: PLANE_KEY_OPTION,
					type: STRING_OPTION,
					description: 'Ключ задачи, например LAB-40',
					required: true,
				},
			],
			contexts: [GUILD_CONTEXT],
			integration_types: [GUILD_INSTALL],
		},
	];
}
