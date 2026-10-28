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
		expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toEqual({
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

	test('appId — тот, что выбрал маршрутизатор: заголовок target-id здесь не читается', () => {
		const d = pullDelivery('opened', {}, {}, { 'x-github-hook-installation-target-id': '777' });
		expect(parseGitHubDelivery(d.headers, d.raw, 31)).toMatchObject({ appId: 31 });
		const ping = pingDelivery();
		expect(parseGitHubDelivery(ping.headers, ping.raw, 32)).toEqual({ kind: 'ping', appId: 32 });
	});

	test('ready_for_review и reopened и converted_to_draft', () => {
		for (const action of ['ready_for_review', 'reopened', 'converted_to_draft'] as const) {
			const d = pullDelivery(action);
			expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toMatchObject({
				kind: 'pull_request',
				action,
			});
		}
	});

	test('merged — closed, merged true, mergeSha', () => {
		const d = pullDelivery('closed', mergedPullBody());
		const event = parseGitHubDelivery(d.headers, d.raw, APP_ID);
		expect(event).toMatchObject({
			kind: 'pull_request',
			action: 'closed',
			pull: { state: 'closed', merged: true, mergeSha: 'd'.repeat(40) },
		});
	});

	test('закрыт без merge — merged false, mergeSha null, хотя GitHub прислал пробный sha', () => {
		const d = pullDelivery('closed', { state: 'closed', merged: false });
		expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toMatchObject({
			pull: { merged: false, mergeSha: null },
		});
	});

	test('тело PR null — пустая строка', () => {
		const d = pullDelivery('opened', { body: null });
		expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toMatchObject({ pull: { body: '' } });
	});

	test('edited с изменением заголовка — edited; без изменения заголовка — null', () => {
		const withTitle = pullDelivery('edited', {}, { changes: { title: { from: 'Old title' } } });
		expect(parseGitHubDelivery(withTitle.headers, withTitle.raw, APP_ID)).toMatchObject({
			action: 'edited',
		});
		const bodyOnly = pullDelivery('edited', {}, { changes: { body: { from: 'old' } } });
		expect(parseGitHubDelivery(bodyOnly.headers, bodyOnly.raw, APP_ID)).toBeNull();
		const noChanges = pullDelivery('edited');
		expect(parseGitHubDelivery(noChanges.headers, noChanges.raw, APP_ID)).toBeNull();
	});

	test('synchronize, labeled — null', () => {
		for (const action of ['synchronize', 'labeled']) {
			const d = pullDelivery(action);
			expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toBeNull();
		}
	});

	test('deployment_status success — deployment с creator и environment, state success', () => {
		const d = deploymentStatusDelivery('success');
		expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toEqual({
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
			at: '2026-10-20T10:06:00.000Z',
		});
	});

	test('deployment_status без log_url — logUrl null; пустое описание остаётся пустым', () => {
		const d = deploymentStatusDelivery('failure', { description: null }, { log_url: '' });
		expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toMatchObject({
			state: 'failure',
			logUrl: null,
			deployment: { description: null },
		});
	});

	test('deployment без creator (null) — creator пустая строка, доставка не отвергается', () => {
		for (const creator of [null, {}]) {
			const d = deploymentStatusDelivery('success', { creator });
			expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toMatchObject({
				deployment: { creator: '' },
			});
		}
	});

	test('все семь состояний деплоя принимаются как есть', () => {
		for (const state of [
			'success',
			'failure',
			'error',
			'inactive',
			'in_progress',
			'queued',
			'pending',
		]) {
			const d = deploymentStatusDelivery(state);
			expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toMatchObject({ state });
		}
	});

	test('деплой без id, sha или environment, дробный id — BadPayload', () => {
		for (const deployment of [
			{ id: undefined },
			{ id: 1.5 },
			{ sha: '' },
			{ environment: undefined },
		]) {
			const d = deploymentStatusDelivery('success', deployment);
			expect(() => parseGitHubDelivery(d.headers, d.raw, APP_ID)).toThrow(BadPayload);
		}
	});

	test('repository.full_name не owner/name, installation без id, дробный number — BadPayload', () => {
		const badRepo = pullDelivery('opened', {}, { repository: { full_name: 'noslash' } });
		expect(() => parseGitHubDelivery(badRepo.headers, badRepo.raw, APP_ID)).toThrow(BadPayload);
		const noInstallId = pullDelivery('opened', {}, { installation: {} });
		expect(() => parseGitHubDelivery(noInstallId.headers, noInstallId.raw, APP_ID)).toThrow(
			BadPayload,
		);
		const fractional = pullDelivery('opened', { number: 1.5 });
		expect(() => parseGitHubDelivery(fractional.headers, fractional.raw, APP_ID)).toThrow(
			BadPayload,
		);
	});

	test('PR без html_url или head.ref — BadPayload', () => {
		for (const pull of [{ html_url: undefined }, { head: { ref: '' } }, { base: undefined }]) {
			const d = pullDelivery('opened', pull);
			expect(() => parseGitHubDelivery(d.headers, d.raw, APP_ID)).toThrow(BadPayload);
		}
	});

	test('неизвестное состояние деплоя — null (событие игнорируется, не 400); не строка — BadPayload', () => {
		const d = deploymentStatusDelivery('exploded');
		expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toBeNull();
		const bad = deploymentStatusDelivery('success', {}, { state: 5 });
		expect(() => parseGitHubDelivery(bad.headers, bad.raw, APP_ID)).toThrow(BadPayload);
	});

	test('installation — null; ping — ping', () => {
		const inst = installationDelivery();
		expect(parseGitHubDelivery(inst.headers, inst.raw, APP_ID)).toBeNull();
		const ping = pingDelivery();
		expect(parseGitHubDelivery(ping.headers, ping.raw, APP_ID)).toEqual({
			kind: 'ping',
			appId: APP_ID,
		});
	});

	test('чужое событие — null, даже с битым телом', () => {
		const d = deliveryOf('star', 'not json');
		expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toBeNull();
	});

	test('битый JSON — BadPayload', () => {
		const d = deliveryOf('pull_request', '{"action":');
		expect(() => parseGitHubDelivery(d.headers, d.raw, APP_ID)).toThrow(BadPayload);
	});

	test('PR без number — BadPayload', () => {
		const d = pullDelivery('opened', { number: undefined });
		expect(() => parseGitHubDelivery(d.headers, d.raw, APP_ID)).toThrow(BadPayload);
	});

	test('нет installation, нет repository, нет заголовка доставки — BadPayload', () => {
		const noInstall = pullDelivery('opened', {}, { installation: undefined });
		expect(() => parseGitHubDelivery(noInstall.headers, noInstall.raw, APP_ID)).toThrow(BadPayload);
		const noRepo = pullDelivery('opened', {}, { repository: undefined });
		expect(() => parseGitHubDelivery(noRepo.headers, noRepo.raw, APP_ID)).toThrow(BadPayload);
		const noId = pullDelivery('opened', {}, {}, { 'x-github-delivery': null });
		expect(() => parseGitHubDelivery(noId.headers, noId.raw, APP_ID)).toThrow(BadPayload);
	});

	test('deployment_status: at — created_at самого статуса в ISO, не время создания деплоя', () => {
		const d = deploymentStatusDelivery(
			'success',
			{ created_at: '2026-10-20T09:00:00Z' },
			{ created_at: '2026-10-20T12:06:00+02:00' },
		);
		expect(parseGitHubDelivery(d.headers, d.raw, APP_ID)).toMatchObject({
			at: '2026-10-20T10:06:00.000Z',
		});
	});

	test('deployment_status без created_at или с не-временем — BadPayload', () => {
		for (const created_at of [undefined, '', 'yesterday', 1_791_281_400_000]) {
			const d = deploymentStatusDelivery('success', {}, { created_at });
			expect(() => parseGitHubDelivery(d.headers, d.raw, APP_ID)).toThrow(
				'deployment_status.created_at',
			);
		}
	});

	test('тело — не объект: BadPayload', () => {
		const d = deliveryOf('pull_request', '[]');
		expect(() => parseGitHubDelivery(d.headers, d.raw, APP_ID)).toThrow(BadPayload);
	});
});
