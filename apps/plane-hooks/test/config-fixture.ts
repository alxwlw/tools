import { generateKeyPairSync } from 'node:crypto';
import { DEFAULT_PRIORITY, type ServiceConfig, type Tenant } from '../src/config.ts';

export const TEST_KEY_PEM = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/** The `acme` tenant of tenants.example.json with every input on. */
export function tenantOf(overrides: Partial<Tenant> = {}): Tenant {
	return {
		id: 'acme',
		workspace: 'example-ws',
		plane: {
			clientId: 'example-client-id',
			clientSecret: 'plane-secret',
			appInstallationId: '00000000-0000-4000-8000-000000000002',
		},
		github: [
			{
				name: 'acme',
				appId: 1000001,
				owner: 'acme',
				privateKeyPem: TEST_KEY_PEM,
				webhookSecret: 'gh-secret',
			},
		],
		incidents: { project: 'INC', priority: DEFAULT_PRIORITY },
		delivery: {
			states: { review: 'In Review', done: 'Done' },
			hold: ['Blocked'],
			repos: [
				{
					repo: 'acme/api',
					environments: [
						{ name: 'staging', state: 'On staging', release: false },
						{ name: 'production', state: 'Done', release: true },
					],
				},
				{ repo: 'acme/*', environments: [] },
			],
			projects: { QA: { Done: 'Ready for retest' } },
		},
		dokploy: [{ name: 'api', repo: 'acme/api', environment: 'production' }],
		inputs: {
			grafana: `ph_${'a'.repeat(48)}`,
			vercel: 'vercel-secret',
			dokploy: 'dokploy-secret',
		},
		silenceHours: { vercel: 72 },
		...overrides,
	};
}

export function serviceConfigOf(tenants: Tenant[] = [tenantOf()]): ServiceConfig {
	return {
		port: 8080,
		planeUrl: 'https://plane.example.com',
		publicUrl: 'https://hooks.example.com',
		tenants,
	};
}
