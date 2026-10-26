// Adapted from apps/plane-discord/test/config-fixture.ts.
import type { Config } from '../src/config.ts';

export const configOf = (): Config => ({
	port: 8080,
	planeUrl: 'https://plane.example.com',
	publicUrl: 'https://plane-miro.example.com',
	configPath: '/config/tenants.json',
	dbPath: ':memory:',
	miro: { clientId: '3458764500000000099', clientSecret: 'miro-sec' },
	tenants: [
		{
			id: 'acme',
			workspace: 'example-ws',
			workspaceId: '00000000-0000-4000-8000-000000000001',
			auth: { clientId: 'client&id', clientSecret: 'sec', appInstallationId: 'inst' },
			webhookSecret: 'hook',
			miroTeamId: '3458764500000000001',
			embed: true,
			keepSource: true,
			silenceHours: 72,
			hiddenProjects: [],
		},
	],
});

/** Full valid env for the `acme` and `beta` tenants; PLANE_MIRO_DB is left unset on purpose. */
export const env = (): Record<string, string> => ({
	PLANE_MIRO_PLANE_URL: 'https://plane.example.com/',
	PLANE_MIRO_PUBLIC_URL: 'https://plane-miro.example.com',
	PLANE_MIRO_MIRO_CLIENT_ID: '3458764500000000099',
	PLANE_MIRO_MIRO_CLIENT_SECRET: 'miro-secret',
	PLANE_MIRO_ACME_PLANE_SECRET: 'acme-plane-secret',
	PLANE_MIRO_ACME_WEBHOOK_SECRET: 'acme-webhook-secret',
	PLANE_MIRO_BETA_PLANE_SECRET: 'beta-plane-secret',
	PLANE_MIRO_BETA_WEBHOOK_SECRET: 'beta-webhook-secret',
});

/** A readFile that ignores the path and returns the given file content. */
export const read = (file: string) => (): string => file;

type TenantFile = Record<string, unknown>;
const tenant = (id: string, n: number, over: TenantFile = {}): TenantFile => ({
	id,
	workspace: `example-ws-${id}`,
	workspaceId: `00000000-0000-4000-8000-00000000001${n}`,
	plane: {
		clientId: `${id}-client`,
		appInstallationId: `00000000-0000-4000-8000-00000000002${n}`,
	},
	miro: { teamId: `345876450000000000${n}` },
	embed: n === 1,
	...over,
});
const file = (...tenants: TenantFile[]): string => JSON.stringify({ tenants });

export const twoTenants = file(tenant('acme', 1), tenant('beta', 2));
export const sameTeam = file(
	tenant('acme', 1),
	tenant('beta', 2, { miro: { teamId: '3458764500000000001' } }),
);
export const badTeam = file(tenant('acme', 1, { miro: { teamId: 'team-1' } }));
export const badEmbed = file(tenant('acme', 1, { embed: 'yes' }));
