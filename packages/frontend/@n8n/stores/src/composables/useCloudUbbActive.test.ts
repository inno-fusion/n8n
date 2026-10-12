import type { FrontendSettings } from '@n8n/api-types';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { useSettingsStore } from '../settings.store';
import { ASSISTANT_CLOUD_UBB_GA_DATE, useCloudUbbActive } from './useCloudUbbActive';

let settingsStore: ReturnType<typeof useSettingsStore>;

const settingsFor = ({
	deploymentType = 'cloud',
	cloudUbbEnabled = false,
}: { deploymentType?: string; cloudUbbEnabled?: boolean } = {}) =>
	mock<FrontendSettings>({
		deployment: { type: deploymentType },
		aiAssistant: { enabled: true, setup: true, cloudUbbEnabled },
	});

describe('useCloudUbbActive', () => {
	beforeEach(() => {
		setActivePinia(createPinia());
		settingsStore = useSettingsStore();
		vi.useFakeTimers();
		// Freeze before GA so the license flag is the only lever unless a test steps past GA.
		vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	test('is true on cloud when the entitlement flag is set, before GA', () => {
		settingsStore.setSettings(settingsFor({ cloudUbbEnabled: true }));

		const { isActive } = useCloudUbbActive();

		expect(isActive.value).toBe(true);
	});

	test('is false on cloud when the entitlement flag is not set, before GA', () => {
		settingsStore.setSettings(settingsFor({ cloudUbbEnabled: false }));

		const { isActive } = useCloudUbbActive();

		expect(isActive.value).toBe(false);
	});

	describe.each([
		{ period: 'before GA', date: new Date('2026-09-15T00:00:00Z'), pastGa: false },
		{ period: 'at GA', date: ASSISTANT_CLOUD_UBB_GA_DATE, pastGa: true },
		{ period: 'after GA', date: new Date('2026-10-02T00:00:00Z'), pastGa: true },
	])('$period', ({ date, pastGa }) => {
		test.each([false, true])(
			'is false on self-hosted deployments with cloudUbbEnabled=%s',
			(cloudUbbEnabled) => {
				settingsStore.setSettings(settingsFor({ deploymentType: 'default', cloudUbbEnabled }));
				vi.setSystemTime(date);

				const { isActive } = useCloudUbbActive();

				expect(isActive.value).toBe(false);
			},
		);

		if (pastGa) {
			test.each([false, true])('is true on cloud with cloudUbbEnabled=%s', (cloudUbbEnabled) => {
				settingsStore.setSettings(settingsFor({ cloudUbbEnabled }));
				vi.setSystemTime(date);

				const { isActive } = useCloudUbbActive();

				expect(isActive.value).toBe(true);
			});
		}
	});

	// A tab kept open across the GA cutoff must flip on its own; `useNow` is why
	// this composable exists over a plain `Date.now()`. Mount before GA, then
	// advance the fake clock past it and past one poll interval to trigger the tick.
	test('reactively activates cloud when the clock crosses GA while mounted', async () => {
		settingsStore.setSettings(settingsFor({ cloudUbbEnabled: false }));

		const { isActive } = useCloudUbbActive();
		expect(isActive.value).toBe(false);

		vi.setSystemTime(new Date(ASSISTANT_CLOUD_UBB_GA_DATE.getTime() + 1_000));
		await vi.advanceTimersByTimeAsync(60_000);

		expect(isActive.value).toBe(true);
	});

	test.each([false, true])(
		'keeps self-hosted deployments inactive across GA with cloudUbbEnabled=%s',
		async (cloudUbbEnabled) => {
			settingsStore.setSettings(settingsFor({ deploymentType: 'default', cloudUbbEnabled }));

			const { isActive } = useCloudUbbActive();
			expect(isActive.value).toBe(false);

			vi.setSystemTime(new Date(ASSISTANT_CLOUD_UBB_GA_DATE.getTime() + 1_000));
			await vi.advanceTimersByTimeAsync(60_000);

			expect(isActive.value).toBe(false);
		},
	);

	test.each([
		{
			period: 'before GA with the entitlement',
			date: new Date('2026-09-15T00:00:00Z'),
			cloudUbbEnabled: true,
		},
		{
			period: 'after GA without the entitlement',
			date: new Date('2026-10-02T00:00:00Z'),
			cloudUbbEnabled: false,
		},
	])('reactively follows the deployment type $period', ({ date, cloudUbbEnabled }) => {
		settingsStore.setSettings(settingsFor({ cloudUbbEnabled }));
		vi.setSystemTime(date);

		const { isActive } = useCloudUbbActive();
		expect(isActive.value).toBe(true);

		settingsStore.setSettings(settingsFor({ deploymentType: 'default', cloudUbbEnabled }));
		expect(isActive.value).toBe(false);

		settingsStore.setSettings(settingsFor({ cloudUbbEnabled }));
		expect(isActive.value).toBe(true);
	});
});
