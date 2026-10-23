import { describe, expect, test } from 'bun:test';

import { CREATE_COMMAND } from '../src/discord/commands.ts';
import { commandPayload, submitPayload } from './discord-harness.ts';
import {
	GUILD,
	HIDDEN,
	MAPPED,
	msg,
	P_LAB,
	SECRET_TEXT,
	setup,
	UNMAPPED,
} from './interactions-world.ts';

describe('createInteractionHandler: ix.refused', () => {
	const command = (id: string, over: { channel?: Record<string, unknown>; name?: string } = {}) =>
		commandPayload({
			id,
			guildId: GUILD,
			channel: over.channel ?? { id: UNMAPPED, type: 0 },
			name: over.name ?? CREATE_COMMAND,
			message: msg({ content: SECRET_TEXT }),
		});

	const cases: Array<{
		reason: string;
		world: Parameters<typeof setup>[0];
		payload: (id: string) => Record<string, unknown>;
		hide?: boolean;
	}> = [
		{ reason: 'cold_cache', world: { cached: null }, payload: (id) => command(id) },
		{ reason: 'no_projects', world: { cached: [HIDDEN] }, payload: (id) => command(id) },
		{
			reason: 'hidden_project',
			world: {},
			hide: true,
			payload: (id) => command(id, { channel: { id: MAPPED, type: 0 } }),
		},
		{ reason: 'unknown_command', world: {}, payload: (id) => command(id, { name: 'другая' }) },
		{
			reason: 'unknown_command',
			world: {},
			payload: (id) => ({ ...command(id), type: 3 }),
		},
		{
			reason: 'no_channel',
			world: {},
			payload: (id) => ({ ...command(id), channel: undefined, channel_id: undefined }),
		},
		{
			reason: 'no_message',
			world: {},
			payload: (id) => ({ ...command(id), data: { type: 3, name: CREATE_COMMAND } }),
		},
		{
			reason: 'expired_form',
			world: {},
			payload: (id) =>
				submitPayload({
					id,
					guildId: GUILD,
					customId: 'create:давно-забытая',
					texts: { title: 'X' },
				}),
		},
	];

	for (const c of cases) {
		test(`${c.reason}: одна строка лога с причиной, без текстов`, async () => {
			const w = await setup(c.world);
			if (c.hide === true) w.rt.tenant.hiddenProjects = [P_LAB];
			const id = w.ids.next();
			const res = await w.ask(c.payload(id));
			expect(res.body.type).toBe(4);
			expect(w.logs).toEqual([
				{
					event: 'ix.refused',
					level: 'warn',
					tenant: 'initech',
					interaction: id,
					reason: c.reason,
				},
			]);
			expect(JSON.stringify(w.logs)).not.toContain(SECRET_TEXT);
		});
	}
});
