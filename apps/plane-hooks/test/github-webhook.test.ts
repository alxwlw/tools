import { describe, expect, test } from 'bun:test';

import { parseGitHubDelivery, verifyGitHubSignature } from '../src/github/webhook.ts';
import { BadPayload } from '../src/payload.ts';
import { mergedPullBody } from './github-bodies.ts';
import {
	APP_ID,
	DELIVERY_ID,
	deliveryOf,
	deploymentStatusDelivery,
	INSTALLATION_ID,
	installationDelivery,
	pingDelivery,
	pullDelivery,
	sign,
	WEBHOOK_SECRET,
} from './github-deliveries.ts';

describe('подпись доставки', () => {
	const raw = new TextEncoder().encode('{"zen":"x"}');
	const good = sign(WEBHOOK_SECRET, raw);

	test('верная — true', () => {
		expect(verifyGitHubSignature(WEBHOOK_SECRET, good, raw)).toBe(true);
	});

	test('чужой секрет — false', () => {
		expect(verifyGitHubSignature('other-secret', good, raw)).toBe(false);
	});

	test('другое тело — false', () => {
		expect(verifyGitHubSignature(WEBHOOK_SECRET, good, new TextEncoder().encode('{}'))).toBe(false);
	});

	test('нет заголовка — false', () => {
		expect(verifyGitHubSignature(WEBHOOK_SECRET, null, raw)).toBe(false);
	});

	test('sha1= вместо sha256= — false', () => {
		expect(verifyGitHubSignature(WEBHOOK_SECRET, good.replace('sha256=', 'sha1='), raw)).toBe(
			false,
		);
	});

	test('63 hex-знака — false, 65 — false', () => {
		expect(verifyGitHubSignature(WEBHOOK_SECRET, good.slice(0, -1), raw)).toBe(false);
		expect(verifyGitHubSignature(WEBHOOK_SECRET, `${good}0`, raw)).toBe(false);
	});

	test('не hex при длине 64 — false', () => {
		expect(verifyGitHubSignature(WEBHOOK_SECRET, `sha256=${'z'.repeat(64)}`, raw)).toBe(false);
	});
});

describe('разбор доставки', () => {
	test('черновой PR открыт — pull_request opened, draft true, appId из заголовка', () => {
		const d = pullDelivery('opened', { draft: true });
		expect(parseGitHubDelivery(d.headers, d.raw)).toEqual({
			kind: 'pull_request',
			appId: APP_ID,
			deliveryId: DELIVERY_ID,
			installationId: INSTALLATION_ID,
			action: 'opened',
			pull: {
				repo: 'acme/api',
				number: 12,
				url: 'https://github.com/acme/api/pull/12',
				title: 'Add retry to the uploader',
				body: 'Closes ENG-7',
				head: 'eng-7-retry',
				base: 'main',
				draft: true,
				state: 'open',
				merged: false,
				mergeSha: null,
			},
		});
	});

	test('appId берётся из заголовка, а не из тела', () => {
		const d = pullDelivery('opened', {}, {}, { 'x-github-hook-installation-target-id': '777' });
		expect(parseGitHubDelivery(d.headers, d.raw)).toMatchObject({ appId: 777 });
	});

	test('ready_for_review и reopened и converted_to_draft', () => {
		for (const action of ['ready_for_review', 'reopened', 'converted_to_draft'] as const) {
			const d = pullDelivery(action);
			expect(parseGitHubDelivery(d.headers, d.raw)).toMatchObject({ kind: 'pull_request', action });
		}
	});

	test('merged — closed, merged true, mergeSha', () => {
		const d = pullDelivery('closed', mergedPullBody());
		const event = parseGitHubDelivery(d.headers, d.raw);
		expect(event).toMatchObject({
			kind: 'pull_request',
			action: 'closed',
			pull: { state: 'closed', merged: true, mergeSha: 'd'.repeat(40) },
		});
	});

	test('закрыт без merge — merged false, mergeSha null, хотя GitHub прислал пробный sha', () => {
		const d = pullDelivery('closed', { state: 'closed', merged: false });
		expect(parseGitHubDelivery(d.headers, d.raw)).toMatchObject({
			pull: { merged: false, mergeSha: null },
		});
	});

	test('тело PR null — пустая строка', () => {
		const d = pullDelivery('opened', { body: null });
		expect(parseGitHubDelivery(d.headers, d.raw)).toMatchObject({ pull: { body: '' } });
	});

	test('edited с изменением заголовка — edited; без изменения заголовка — null', () => {
		const withTitle = pullDelivery('edited', {}, { changes: { title: { from: 'Old title' } } });
		expect(parseGitHubDelivery(withTitle.headers, withTitle.raw)).toMatchObject({
			action: 'edited',
		});
		const bodyOnly = pullDelivery('edited', {}, { changes: { body: { from: 'old' } } });
		expect(parseGitHubDelivery(bodyOnly.headers, bodyOnly.raw)).toBeNull();
		const noChanges = pullDelivery('edited');
		expect(parseGitHubDelivery(noChanges.headers, noChanges.raw)).toBeNull();
	});

	test('synchronize, labeled — null', () => {
		for (const action of ['synchronize', 'labeled']) {
			const d = pullDelivery(action);
			expect(parseGitHubDelivery(d.headers, d.raw)).toBeNull();
		}
	});

	test('deployment_status success — deployment с creator и environment, state success', () => {
		const d = deploymentStatusDelivery('success');
		expect(parseGitHubDelivery(d.headers, d.raw)).toEqual({
			kind: 'deployment_status',
			appId: APP_ID,
			deliveryId: DELIVERY_ID,
			installationId: INSTALLATION_ID,
			deployment: {
				id: 501,
				repo: 'acme/api',
				sha: 'e'.repeat(40),
				environment: 'production',
				creator: 'github-actions[bot]',
				description: 'Deploy main',
			},
			state: 'success',
			logUrl: 'https://example.com/deploys/501',
		});
	});

	test('deployment_status без log_url — logUrl null; пустое описание остаётся пустым', () => {
		const d = deploymentStatusDelivery('failure', { description: null }, { log_url: '' });
		expect(parseGitHubDelivery(d.headers, d.raw)).toMatchObject({
			state: 'failure',
			logUrl: null,
			deployment: { description: null },
		});
	});

	test('deployment без creator (null) — creator пустая строка, доставка не отвергается', () => {
		for (const creator of [null, {}]) {
			const d = deploymentStatusDelivery('success', { creator });
			expect(parseGitHubDelivery(d.headers, d.raw)).toMatchObject({
				deployment: { creator: '' },
			});
		}
	});

	test('неизвестное состояние деплоя — BadPayload', () => {
		const d = deploymentStatusDelivery('exploded');
		expect(() => parseGitHubDelivery(d.headers, d.raw)).toThrow(BadPayload);
	});

	test('installation — null; ping — ping', () => {
		const inst = installationDelivery();
		expect(parseGitHubDelivery(inst.headers, inst.raw)).toBeNull();
		const ping = pingDelivery();
		expect(parseGitHubDelivery(ping.headers, ping.raw)).toEqual({ kind: 'ping', appId: APP_ID });
	});

	test('чужое событие — null, даже с битым телом', () => {
		const d = deliveryOf('star', 'not json');
		expect(parseGitHubDelivery(d.headers, d.raw)).toBeNull();
	});

	test('битый JSON — BadPayload', () => {
		const d = deliveryOf('pull_request', '{"action":');
		expect(() => parseGitHubDelivery(d.headers, d.raw)).toThrow(BadPayload);
	});

	test('PR без number — BadPayload', () => {
		const d = pullDelivery('opened', { number: undefined });
		expect(() => parseGitHubDelivery(d.headers, d.raw)).toThrow(BadPayload);
	});

	test('нет installation, нет repository, нет заголовка доставки — BadPayload', () => {
		const noInstall = pullDelivery('opened', {}, { installation: undefined });
		expect(() => parseGitHubDelivery(noInstall.headers, noInstall.raw)).toThrow(BadPayload);
		const noRepo = pullDelivery('opened', {}, { repository: undefined });
		expect(() => parseGitHubDelivery(noRepo.headers, noRepo.raw)).toThrow(BadPayload);
		const noId = pullDelivery('opened', {}, {}, { 'x-github-delivery': null });
		expect(() => parseGitHubDelivery(noId.headers, noId.raw)).toThrow(BadPayload);
	});

	test('нет или кривой x-github-hook-installation-target-id — BadPayload', () => {
		for (const value of [null, 'abc', '0', '-1', '1.5', '1e3', '0x10']) {
			const d = pullDelivery('opened', {}, {}, { 'x-github-hook-installation-target-id': value });
			expect(() => parseGitHubDelivery(d.headers, d.raw)).toThrow(BadPayload);
		}
	});

	test('тело — не объект: BadPayload', () => {
		const d = deliveryOf('pull_request', '[]');
		expect(() => parseGitHubDelivery(d.headers, d.raw)).toThrow(BadPayload);
	});
});
