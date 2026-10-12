import assert from 'node:assert/strict';
import test from 'node:test';

import { readFile } from 'node:fs/promises';

import {
	componentFor,
	declaredLicenses,
	normalizeLicenseRefs,
	preserveRegistryTerms,
} from './fork-runtime-licenses.mjs';
import { renderSbom } from './licenses/render-licenses-md.mjs';

const registryPurl = 'pkg:npm/%40n8n/sandbox-client@0.1.1';

test('uses CycloneDX name for custom license references and retains text', () => {
	const license = { id: 'LicenseRef-n8n-enterprise', text: { content: 'Original terms' } };
	const sbom = normalizeLicenseRefs({
		components: [{ purl: 'pkg:npm/sdk@1.0.0', licenses: [{ license }] }],
	});
	assert.deepEqual(sbom.components[0].licenses, [
		{ license: { name: 'LicenseRef-n8n-enterprise', text: license.text } },
	]);
	assert.equal(license.id, 'LicenseRef-n8n-enterprise');
});

test('does not change real SPDX identifiers', () => {
	const sbom = { components: [{ licenses: [{ license: { id: 'MIT' } }] }] };
	assert.deepEqual(normalizeLicenseRefs(sbom), sbom);
});

test('preserves registry package terms instead of the modified workspace license', async () => {
	const text = await readFile(
		new URL('./licenses/fork/sandbox-client-0.1.1-LICENSE.md', import.meta.url),
		'utf8',
	);
	const terms = {
		[registryPurl]: {
			name: 'LicenseRef-n8n-sustainable-use',
			text,
			url: 'https://github.com/n8n-io/n8n-sandbox-service/blob/b9b4ee5995296b2d2c791a68711ed7e9886a0d57/LICENSE.md',
		},
	};
	const sbom = preserveRegistryTerms(
		{
			components: [
				{
					...componentFor({ name: '@n8n/sandbox-client', version: '0.1.1' }),
					licenses: [
						{
							license: {
								name: 'LicenseRef-n8n-sustainable-use',
								text: { content: 'Open Freedom License' },
							},
						},
					],
				},
			],
		},
		terms,
	);
	const license = sbom.components[0].licenses[0].license;
	assert.match(license.text.content, /Sustainable Use License/);
	assert.doesNotMatch(license.text.content, /Open Freedom/);
	const rendered = await renderSbom(sbom, {}, { skipFirstParty: () => false });
	assert.match(rendered.markdown, /@n8n\/sandbox-client 0\.1\.1/);
	assert.match(rendered.markdown, /Sustainable Use License/);
	assert.equal(rendered.summary.externalComponents, 1);
});

test('requires new evidence when the registry SDK version changes', () => {
	const component = componentFor({ name: '@n8n/sandbox-client', version: '0.2.0' });
	assert.throws(
		() =>
			preserveRegistryTerms(
				{ components: [component] },
				{ [registryPurl]: { name: 'LicenseRef-n8n-sustainable-use', text: 'Verified terms' } },
			),
		/Unverified registry license/,
	);
});

test('reads current and legacy license declarations from real manifests', () => {
	assert.deepEqual(declaredLicenses({ license: 'MIT' }), [{ expression: 'MIT' }]);
	assert.deepEqual(declaredLicenses({ license: { type: 'Apache-2.0' } }), [
		{ expression: 'Apache-2.0' },
	]);
	assert.deepEqual(declaredLicenses({ licenses: [{ type: 'MIT' }, { type: 'BSD-2-Clause' }] }), [
		{ expression: 'MIT' },
		{ expression: 'BSD-2-Clause' },
	]);
	assert.deepEqual(declaredLicenses({}), []);
});

test('encodes scoped package identity without changing the version', () => {
	const component = componentFor({ name: '@example/runtime', version: '1.2.3', license: 'MIT' });
	assert.equal(component.group, '@example');
	assert.equal(component.name, 'runtime');
	assert.equal(component.purl, 'pkg:npm/%40example/runtime@1.2.3');
	assert.equal(component['bom-ref'], component.purl);
});

test('keeps unscoped package identity intact', () => {
	assert.equal(componentFor({ name: 'runtime', version: '1.2.3' }).purl, 'pkg:npm/runtime@1.2.3');
});

test('rejects incomplete package identity instead of creating fake attribution', () => {
	assert.throws(() => componentFor({ name: 'runtime' }));
	assert.throws(() => componentFor({ version: '1.2.3' }));
});
