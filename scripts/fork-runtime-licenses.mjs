#!/usr/bin/env node
// Read attribution from the deployed packages. Do not fetch registry metadata.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadSpdxIds, validateComponentLicenses } from './licenses/check-sbom-licenses.mjs';
import { buildFirstPartyOsiMap, enrichSbom, loadLicenseConfig } from './licenses/enrich-sbom.mjs';
import { isFirstParty, readLicenseFromDisk, renderSbom } from './licenses/render-licenses-md.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

export function declaredLicenses(manifest) {
	const values = manifest.license ? [manifest.license] : (manifest.licenses ?? []);
	return values
		.map((value) => {
			const expression = typeof value === 'string' ? value : (value.type ?? value.name);
			return { expression };
		})
		.filter((entry) => entry.expression);
}

export function componentFor(manifest) {
	assert.ok(manifest.name && manifest.version, 'Package name and version are required');
	const slash = manifest.name.indexOf('/');
	const group = slash < 0 ? undefined : manifest.name.slice(0, slash);
	const name = slash < 0 ? manifest.name : manifest.name.slice(slash + 1);
	const purl =
		'pkg:npm/' +
		(group ? encodeURIComponent(group) + '/' : '') +
		encodeURIComponent(name) +
		'@' +
		encodeURIComponent(manifest.version);
	return {
		type: 'library',
		...(group ? { group } : {}),
		name,
		version: manifest.version,
		purl,
		'bom-ref': purl,
		licenses: declaredLicenses(manifest),
	};
}

export function normalizeLicenseRefs(sbom) {
	return {
		...sbom,
		components: sbom.components.map((component) => ({
			...component,
			licenses: component.licenses?.map((entry) => {
				if (!entry.license?.id?.startsWith('LicenseRef-')) return entry;
				const { id, ...license } = entry.license;
				return { ...entry, license: { ...license, name: id } };
			}),
		})),
	};
}

export function preserveRegistryTerms(sbom, terms) {
	const pinnedNames = new Set(
		Object.keys(terms).map((purl) => purl.slice(0, purl.lastIndexOf('@'))),
	);
	return {
		...sbom,
		components: sbom.components.map((component) => {
			const identity = component.purl.slice(0, component.purl.lastIndexOf('@'));
			if (!pinnedNames.has(identity)) return component;
			const verified = terms[component.purl];
			assert.ok(
				verified?.text && verified.name && verified.url,
				'Unverified registry license: ' + component.purl,
			);
			return {
				...component,
				licenses: [
					{
						license: {
							name: verified.name,
							url: verified.url,
							text: { contentType: 'text/markdown', content: verified.text },
						},
					},
				],
			};
		}),
	};
}

async function inventory(closure) {
	const store = path.join(closure, 'node_modules/.pnpm');
	const result = new Map();
	let manifests = 0;
	for (const entry of await readdir(store, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '@') continue;
		const modules = path.join(store, entry.name, 'node_modules');
		for (const candidate of await readdir(modules, { withFileTypes: true })) {
			if (!candidate.isDirectory()) continue;
			const dirs = candidate.name.startsWith('@')
				? (await readdir(path.join(modules, candidate.name), { withFileTypes: true }))
						.filter((child) => child.isDirectory())
						.map((child) => path.join(modules, candidate.name, child.name))
				: [path.join(modules, candidate.name)];
			for (const dir of dirs) {
				const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
				const component = componentFor(manifest);
				if (component.licenses.length === 0) {
					const nodeModules = component.group ? path.dirname(path.dirname(dir)) : path.dirname(dir);
					const text = await readLicenseFromDisk(nodeModules, component);
					if (
						text?.includes('Permission is hereby granted, free of charge') &&
						text.includes('THE SOFTWARE IS PROVIDED "AS IS"')
					) {
						component.licenses = [{ license: { id: 'MIT', text: { content: text } } }];
					} else if (
						text?.includes('Apache License') &&
						text.includes('Version 2.0, January 2004')
					) {
						component.licenses = [{ license: { id: 'Apache-2.0', text: { content: text } } }];
					}
				}
				result.set(component.purl, { component, dir });
				manifests++;
			}
		}
	}
	assert.ok(result.size > 1000, 'The production inventory is incomplete');
	return { result, manifests };
}

export async function generate(closure) {
	const { result, manifests } = await inventory(closure);
	const config = await loadLicenseConfig();
	const validIds = await loadSpdxIds();
	const firstPartyOsi = await buildFirstPartyOsiMap(path.join(root, 'packages'), validIds);
	const components = [...result.values()].map(({ component }) => component);
	const sbom = { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, components };
	// These SDKs carry explicit enterprise terms, not the main project license.
	for (const component of components) {
		const qualified = component.group ? component.group + '/' + component.name : component.name;
		if (qualified.startsWith('@n8n_io/') && config.byName[qualified]) {
			config.overrides[component.purl] = config.byName[qualified];
		}
	}
	const enriched = enrichSbom(sbom, {
		...config,
		firstPartyOsi,
		licenseText: await readFile(path.join(root, 'LICENSE.md'), 'utf8'),
	});
	const registryTerms = {
		'pkg:npm/%40n8n/sandbox-client@0.1.1': {
			name: 'LicenseRef-n8n-sustainable-use',
			url: 'https://github.com/n8n-io/n8n-sandbox-service/blob/b9b4ee5995296b2d2c791a68711ed7e9886a0d57/LICENSE.md',
			text: await readFile(
				path.join(root, 'scripts/licenses/fork/sandbox-client-0.1.1-LICENSE.md'),
				'utf8',
			),
		},
	};
	const resolved = normalizeLicenseRefs(preserveRegistryTerms(enriched.sbom, registryTerms));
	const skipFirstParty = (purl) => isFirstParty(purl) && !registryTerms[purl];
	const allowRefs = new Set(['LicenseRef-n8n-sustainable-use', 'LicenseRef-n8n-enterprise']);
	const invalid = resolved.components.flatMap((component) => {
		const status = validateComponentLicenses(component, validIds, allowRefs);
		return status.ok ? [] : [{ purl: component.purl, reason: status.reason }];
	});
	assert.equal(invalid.length, 0, 'Unresolved runtime licenses: ' + JSON.stringify(invalid));
	const matchedOverrides = Object.fromEntries(
		Object.entries(config.overrides).filter(([purl]) => result.has(purl) && !skipFirstParty(purl)),
	);
	const rendered = await renderSbom(resolved, matchedOverrides, {
		skipFirstParty,
		readDiskText: async (component) => {
			const actual = result.get(component.purl).dir;
			const nodeModules = component.group
				? path.dirname(path.dirname(actual))
				: path.dirname(actual);
			return await readLicenseFromDisk(nodeModules, component);
		},
	});
	assert.equal(rendered.unresolved.length, 0);
	assert.equal(rendered.unusedOverrides.length, 0);
	await writeFile(
		path.join(closure, 'sbom-runtime.cdx.json'),
		JSON.stringify(resolved, null, 2) + '\n',
	);
	await writeFile(path.join(closure, 'THIRD_PARTY_LICENSES.md'), rendered.markdown);
	const report = {
		installedManifests: manifests,
		...rendered.summary,
		source: 'installed production package manifests and license files',
	};
	await writeFile(
		path.join(closure, 'license-inventory.json'),
		JSON.stringify(report, null, 2) + '\n',
	);
	console.log(JSON.stringify(report));
	return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await generate(path.resolve(process.argv[2] ?? 'compiled'));
}
