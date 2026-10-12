import { LICENSE_FEATURES, LICENSE_QUOTAS, UNLIMITED_LICENSE_QUOTA } from '@n8n/constants';
import { mock } from 'vitest-mock-extended';

import { LicenseState } from '../license-state';
import type { LicenseProvider } from '../types';

describe('LicenseState enterprise bypass', () => {
	const restrictiveFeatures = new Set<string>([
		LICENSE_FEATURES.API_DISABLED,
		LICENSE_FEATURES.SHOW_NON_PROD_BANNER,
		LICENSE_FEATURES.AI_GATEWAY_CLOUD_UBB,
		LICENSE_FEATURES.AI_ASSISTANT_CLOUD_UBB_ENTITLEMENT,
	]);

	test('enables every current feature except restrictive flags without a provider', () => {
		const state = new LicenseState();

		for (const feature of Object.values(LICENSE_FEATURES)) {
			expect(state.isLicensed(feature)).toBe(!restrictiveFeatures.has(feature));
		}
	});

	test('handles feature arrays without consulting a provider', () => {
		const state = new LicenseState();

		expect(state.isLicensed([LICENSE_FEATURES.SAML, LICENSE_FEATURES.OIDC])).toBe(true);
		expect(state.isLicensed([LICENSE_FEATURES.SAML, LICENSE_FEATURES.API_DISABLED])).toBe(true);
		expect(state.isLicensed([LICENSE_FEATURES.SHOW_NON_PROD_BANNER, LICENSE_FEATURES.OIDC])).toBe(
			true,
		);
		expect(
			state.isLicensed([LICENSE_FEATURES.API_DISABLED, LICENSE_FEATURES.SHOW_NON_PROD_BANNER]),
		).toBe(false);
		expect(state.isLicensed([])).toBe(false);
	});

	test.each([
		LICENSE_FEATURES.AI_GATEWAY_CLOUD_UBB,
		LICENSE_FEATURES.AI_ASSISTANT_CLOUD_UBB_ENTITLEMENT,
	])('delegates cloud billing entitlement %s to the provider', (feature) => {
		const state = new LicenseState();
		expect(state.isLicensed(feature)).toBe(false);
		const provider = mock<LicenseProvider>();
		state.setLicenseProvider(provider);
		provider.isLicensed.mockReturnValue(false);
		expect(state.isLicensed(feature)).toBe(false);
		provider.isLicensed.mockReturnValue(true);
		expect(state.isLicensed(feature)).toBe(true);
		expect(provider.isLicensed).toHaveBeenCalledWith(feature);
		expect(state.isLicensed([feature, LICENSE_FEATURES.API_DISABLED])).toBe(true);
	});

	test('returns unlimited values for every current quota without a provider', () => {
		const state = new LicenseState();

		for (const quota of Object.values(LICENSE_QUOTAS)) {
			expect(state.getValue(quota)).toBe(UNLIMITED_LICENSE_QUOTA);
		}
	});

	test('delegates non-quota values when a provider is available', () => {
		const provider = mock<LicenseProvider>();
		provider.getValue.mockReturnValue('Enterprise');
		const state = new LicenseState();
		state.setLicenseProvider(provider);

		expect(state.getValue('planName')).toBe('Enterprise');
		expect(provider.getValue).toHaveBeenCalledWith('planName');
	});
});
