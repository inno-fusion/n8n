# Fork Release 2.42.7

## Scope

This branch starts at upstream `n8n@2.42.7`. It carries the six fork commits from
`v2.39.5`. It also fixes the source build and the cloud-billing state.

- Enable self-hosted enterprise features and provisioning.
- Return unlimited local quotas and report the Enterprise plan.
- Keep API-disabled and non-production-banner flags false.
- Preserve the any-match contract for feature arrays. An empty array is false.
- Read cloud-billing entitlements from the real license provider. Do not treat
  paid cloud services as local enterprise capabilities.
- Keep Cloud UBB inactive on self-hosted deployments, before and after GA.
- Stop current and late upload streams on parse failure. Wait for pending part
  setup and stream closure before removing parser-owned files.
- Keep authentication, MFA, API scopes, and project authorization unchanged.

A local feature flag does not grant access to the hosted AI gateway. Remote
services still require valid credentials and a balance. Instance AI can use a
custom model endpoint. Workflow building also requires a sandbox service.

## Build

Use the root Dockerfile. Do not pass host artifacts to the upstream Dockerfile.
The build pins Node 26.7.0, pnpm 12.4.2, and the upstream builder/runtime digests.
It compiles the source inside Docker. It uses the dedicated-lockfile deploy path.
It keeps the upstream runtime-asset checks and excludes the test controller.

```sh
DOCKER_BUILDKIT=1 docker build --platform linux/arm64 --progress=plain \
  --build-arg N8N_VERSION=2.42.7 --build-arg N8N_RELEASE_TYPE=stable \
  -t ghcr.io/inno-fusion/n8n:v2.42.7 . > build.log 2>&1
```

Bash is required by the upstream zx deploy script. The runtime native stage
rebuilds SQLite, isolated-vm, and Kafka for the exact Node/Alpine ABI. It removes
incompatible isolated-vm prebuilds. It keeps the non-root runtime user.

## Attribution

The build generates `sbom-runtime.cdx.json`, `license-inventory.json`, and
`THIRD_PARTY_LICENSES.md` from the installed production package manifests and
license files. It reads every physical package at the pnpm virtual-store boundary.
It deduplicates only equal name/version identities. It does not scan nested test
fixtures as separate packages. It does not fetch registry metadata.

The inventory applies the upstream verified license overrides and elections.
Registry SDKs retain their independent terms. The sandbox client uses the exact
license from its npm-provenance source commit. Custom license references use
CycloneDX `name`, not an SPDX `id`. The output passes the official 1.6 schema.
Missing or invalid license declarations fail the build. Packages without a
manifest license can use their shipped MIT or Apache-2.0 license text. The build
never writes a placeholder attribution file. The SBOM lists packages; it does not
claim to provide a complete dependency graph or an OS-package inventory.

## Checks

Run tests from the owning packages. Set `N8N_USER_FOLDER` to a disposable path.
Do not let tests write to a real n8n profile.

```sh
node --test scripts/fork-build-contract.test.mjs scripts/fork-runtime-licenses.test.mjs
node scripts/fork-runtime-licenses.mjs compiled
node scripts/fork-validate-sbom.mjs compiled/sbom-runtime.cdx.json
pnpm --filter n8n test:unit --maxWorkers=3
pnpm --filter @n8n/backend-common test
pnpm --filter @n8n/stores test
pnpm agent:typecheck --filter n8n
pnpm agent:typecheck --filter @n8n/backend-common
pnpm agent:typecheck --filter @n8n/stores
pnpm agent:lint --filter n8n
pnpm agent:lint --filter @n8n/backend-common
pnpm agent:lint --filter @n8n/stores
```

Before publication, verify the ARM64 image with its default VM expression engine.
Load SQLite, isolated-vm, and Kafka as UID 1000. Start a fresh disposable database.
Use the matching `n8nio/runners:2.42.7` sidecar in external mode. Create and publish
a webhook workflow. Evaluate an expression. Run a Code node in the external
runner. Read the saved workflow through the public API. Verify that anonymous,
read-only, and revoked-key requests remain denied. Sign in with a real browser.
Check the saved workflow list and the Enterprise usage page.

## Deployment

This release updates the mod project and its registry image. It does not deploy
the production stack. Back up the production database and encryption keys before
an upgrade. Use a version tag or verified digest. Keep the external runner on the
same n8n version.

A fixture rehearsal from the previous image verifies saved workflows, active
webhooks, owner login, and encrypted credential decryption on the new VM image.
This is not a production-data restoration rehearsal. Do that before production
cutover. Never remove an
existing legacy-expression override solely because this release has a new tag;
verify VM execution on that deployment first.

## Privacy

The upstream diagnostics defaults remain unchanged in this release. For a private
self-hosted deployment, set diagnostics, personalization, templates, and version
notifications to false. Also set `N8N_LICENSE_AUTO_RENEW_ENABLED=false` when no
remote license service is required. Diagnostics alone does not disable license
renewal metrics for a stored certificate.
