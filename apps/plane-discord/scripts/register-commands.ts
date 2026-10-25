// Overwrites the guild commands of every tenant with commandDefinitions(). Run in the container:
//   docker exec <container> bun scripts/register-commands.ts
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { commandDefinitions } from '../src/discord/commands.ts';
import { DiscordRest } from '../src/discord/rest.ts';

const config = loadConfig(process.env, (path) => readFileSync(path, 'utf8'));
const discord = new DiscordRest({
	botToken: config.discord.botToken,
	applicationId: config.discord.applicationId,
});
const commands = commandDefinitions();
for (const tenant of config.tenants) {
	await discord.bulkOverwriteGuildCommands(tenant.guildId, commands);
	console.log(`✓ ${tenant.id} ${commands.length} commands`);
}
