// Prints id, type, parent and name of every channel of every tenant's server (for the channel map). Run in the container:
//   docker exec <container> bun scripts/list-channels.ts
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { DiscordRest } from '../src/discord/rest.ts';

const config = loadConfig(process.env, (path) => readFileSync(path, 'utf8'));
const discord = new DiscordRest({
	botToken: config.discord.botToken,
	applicationId: config.discord.applicationId,
});
for (const tenant of config.tenants) {
	console.log(`# ${tenant.id}`);
	for (const channel of await discord.listGuildChannels(tenant.guildId))
		console.log(
			`${channel.id}\t${channel.type}\t${channel.parentId ?? '-'}\t${channel.name ?? ''}`,
		);
}
