# Maintainer documentation

## Browser image

The browser Sandbox boots from `Dockerfile.sandbox`, which contains
agent-browser, Chromium, and their system dependencies. The image is stored in
the Vercel Container Registry project used by this package.

Install the Vercel CLI and Docker with Buildx, authenticate both CLIs, and link
this directory to the `remote-agent-browser` Vercel project once:

```bash
vercel link
```

Publish `latest`:

```bash
./scripts/publish-image.sh
```

Pass a tag to publish an immutable version instead:

```bash
./scripts/publish-image.sh v0.1.0
```

The script pulls a fresh project-scoped `VERCEL_OIDC_TOKEN` into a temporary
file, logs Docker in to VCR, and builds and pushes both supported Linux
architectures. VCR then optimizes the image for Vercel Sandbox.

## Development

Install dependencies and run the local checks:

```bash
pnpm install
node --run typecheck
node --run test
```

The default suite uses a mocked `Sandbox.create()` and does not create billable
resources. To boot the published image and exercise real Chromium end to end:

```bash
vercel env pull .env.local
set -a; source .env.local; set +a
RUN_INTEGRATION=1 node --run test:integration
```
