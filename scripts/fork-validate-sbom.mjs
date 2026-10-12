#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { validateBom } from '../.github/scripts/node_modules/@cyclonedx/cdxgen/lib/validator/bomValidator.js';

const sbom = JSON.parse(
	await readFile(process.argv[2] ?? 'compiled/sbom-runtime.cdx.json', 'utf8'),
);
assert.equal(validateBom(sbom), true, 'The runtime SBOM must pass the official CycloneDX schema');
console.log('PASS official CycloneDX schema and deep validation');
