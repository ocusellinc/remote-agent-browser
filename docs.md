# Maintainer documentation

## Browser image

The browser Sandbox boots from `Dockerfile.sandbox`, which contains
agent-browser, Chromium, and their system dependencies. The image is stored in
the Vercel Container Registry project used by this package.

Link the repository and pull a current project-scoped registry credential:

```bash
vercel link
vercel env pull .env.local
set -a; source .env.local; set +a
printf '%s' "$VERCEL_OIDC_TOKEN" | docker login vcr.vercel.com \
  --username oidc --password-stdin
```

Build and push both supported Linux architectures:

```bash
docker buildx build \
  -f Dockerfile.sandbox \
  --platform linux/amd64,linux/arm64 \
  --output "type=image,name=vcr.vercel.com/vercel-labs/remote-agent-browser/remote-agent-browser:latest,push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true" \
  .
```

VCR automatically optimizes the pushed image for Vercel Sandbox. Publish an
immutable version tag as well as `latest` for releases that need reproducible
rollbacks.

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
