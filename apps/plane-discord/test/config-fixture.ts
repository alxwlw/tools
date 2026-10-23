import type { Config } from '../src/config.ts';

export const configOf = (): Config => ({
	port: 8080,
	planeUrl: 'https://plane.example.com',
	publicUrl: 'https://plane-discord.example.com',
	configPath: '/config/tenants.json',
	dbPath: ':memory:',
	discord: { applicationId: '123456789012345678', publicKey: 'a'.repeat(64), botToken: 'bot' },
	tenants: [
		{
			id: 'acme',
			guildId: '111111111111111111',
			workspace: 'example-ws',
			workspaceId: '00000000-0000-4000-8000-000000000001',
			auth: { clientId: 'client&id', clientSecret: 'sec', appInstallationId: 'inst' },
			webhookSecret: 'hook',
			serviceChannelId: null,
			silenceHours: 72,
			hiddenProjects: [],
			channels: [],
			users: [],
		},
	],
});
