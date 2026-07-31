#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: $0 [tag]"
  echo "Build and publish the browser image. The tag defaults to latest."
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if (( $# > 1 )); then
  usage >&2
  exit 2
fi

image_tag="${1:-latest}"
image_repository="vcr.vercel.com/vercel-labs/remote-agent-browser/remote-agent-browser"
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! "$image_tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "Invalid Docker image tag: $image_tag" >&2
  exit 2
fi

for command_name in vercel docker; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

if ! docker buildx version >/dev/null 2>&1; then
  echo "Docker Buildx is required" >&2
  exit 1
fi

credentials_file="$(mktemp "${TMPDIR:-/tmp}/remote-agent-browser-env.XXXXXX")"
trap 'rm -f "$credentials_file"' EXIT

(
  cd "$project_dir"
  vercel env pull "$credentials_file" --yes --environment=development
)

set -a
# shellcheck disable=SC1090
source "$credentials_file"
set +a

if [[ -z "${VERCEL_OIDC_TOKEN:-}" ]]; then
  echo "VERCEL_OIDC_TOKEN was not returned by vercel env pull" >&2
  exit 1
fi

printf '%s' "$VERCEL_OIDC_TOKEN" | docker login vcr.vercel.com \
  --username oidc \
  --password-stdin

image_ref="$image_repository:$image_tag"
echo "Publishing $image_ref"

docker buildx build \
  -f "$project_dir/Dockerfile.sandbox" \
  --platform linux/amd64,linux/arm64 \
  --output "type=image,name=$image_ref,push=true,oci-mediatypes=true,compression=zstd,compression-level=3,force-compression=true" \
  "$project_dir"

echo "Published $image_ref"
