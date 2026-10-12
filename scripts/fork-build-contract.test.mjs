import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const dockerfile = fs.readFileSync(root + 'Dockerfile', 'utf8');
const upstream = fs.readFileSync(root + 'docker/images/n8n/Dockerfile', 'utf8');
const manifest = JSON.parse(fs.readFileSync(root + 'package.json', 'utf8'));

test('source build pins the repository package manager', () => {
	assert.ok(dockerfile.includes('npm install --global ' + manifest.packageManager));
	assert.match(dockerfile, /pnpm install --frozen-lockfile/);
	assert.match(dockerfile, /apk add --no-cache bash /);
});

test('builder and runtime images match the release native ABI', () => {
	for (const arg of ['BUILDER_IMAGE', 'RUNTIME_IMAGE']) {
		const pattern = new RegExp('^ARG ' + arg + '=(.+)$', 'm');
		assert.equal(dockerfile.match(pattern)?.[1], upstream.match(pattern)?.[1]);
	}
	for (const module of ['isolated-vm', 'sqlite3', '@confluentinc+kafka-javascript']) {
		assert.ok(dockerfile.includes(module));
	}
	assert.match(dockerfile, /BUILD_LIBRDKAFKA=0/);
	assert.match(dockerfile, /USER node/);
});

test('release deploy generates real attribution and preserves runtime assets', () => {
	assert.match(dockerfile, /N8N_GENERATE_LICENSES=false pnpm build:deploy/);
	assert.match(dockerfile, /node scripts\/fork-runtime-licenses.mjs compiled/);
	assert.doesNotMatch(dockerfile, /--legacy|generation was skipped/);
	assert.match(dockerfile, /COPY --from=build \/app\/compiled\/THIRD_PARTY_LICENSES.md/);
});

test('source context excludes nested dependencies and local environment files', () => {
	const ignore = fs.readFileSync(root + '.dockerignore', 'utf8').split('\n');
	for (const pattern of ['.git', '**/node_modules', '**/.env', '**/.env.*']) {
		assert.ok(ignore.includes(pattern));
	}
});
