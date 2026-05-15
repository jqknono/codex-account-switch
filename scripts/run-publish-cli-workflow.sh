#!/usr/bin/env sh
set -eu

show_help() {
  cat <<'EOF'
run-publish-cli-workflow.sh

Usage:
  ./scripts/run-publish-cli-workflow.sh help
  ./scripts/run-publish-cli-workflow.sh run [--event <push|workflow_dispatch>] [--version <semver>] [--npm-tag <tag>] [--node-version <version>]

Options:
  --event         Workflow event to simulate. Default: workflow_dispatch
  --version       Expected CLI version for workflow_dispatch validation.
  --npm-tag       npm dist-tag override for workflow_dispatch. Default follows workflow logic.
  --node-version  Node.js version to use inside WSL. Default: 24.15.0

Notes:
  - Downloads a Linux Node.js tarball into ~/.cache/codex-account-switch if missing.
  - Mirrors .github/workflows/publish-cli.yml, but replaces the final publish step with npm publish --dry-run.
  - Must be run from the repository root.
EOF
}

command_name="${1:-help}"
shift || true

event_name="workflow_dispatch"
input_version=""
input_npm_tag=""
node_version="24.15.0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --event)
      event_name="${2:-}"
      shift 2
      ;;
    --version)
      input_version="${2:-}"
      shift 2
      ;;
    --npm-tag)
      input_npm_tag="${2:-}"
      shift 2
      ;;
    --node-version)
      node_version="${2:-}"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      show_help >&2
      exit 1
      ;;
  esac
done

case "$command_name" in
  help)
    show_help
    exit 0
    ;;
  run)
    ;;
  *)
    echo "Unknown command: $command_name" >&2
    show_help >&2
    exit 1
    ;;
esac

if [ ! -f "./package.json" ] || [ ! -f "./.github/workflows/publish-cli.yml" ]; then
  echo "Run this script from the repository root." >&2
  exit 1
fi

case "$event_name" in
  push|workflow_dispatch)
    ;;
  *)
    echo "Unsupported event: $event_name" >&2
    exit 1
    ;;
esac

node_dist="node-v${node_version}-linux-x64"
cache_root="${HOME}/.cache/codex-account-switch"
node_root="${cache_root}/${node_dist}"
archive_path="${cache_root}/${node_dist}.tar.xz"

mkdir -p "${cache_root}"

if [ ! -x "${node_root}/bin/node" ]; then
  url="https://nodejs.org/dist/v${node_version}/${node_dist}.tar.xz"
  echo "Downloading ${url}"
  curl -fsSL "${url}" -o "${archive_path}"
  rm -rf "${node_root}"
  tar -xJf "${archive_path}" -C "${cache_root}"
fi

export PATH="${node_root}/bin:${PATH}"

echo "==> Using Node toolchain"
node --version
npm --version

echo "==> npm ci"
npm ci

echo "==> npm run test -w packages/cli"
npm run test -w packages/cli

package_version="$(node -p "require('./packages/cli/package.json').version")"
default_tag="latest"
case "${package_version}" in
  *-*)
    default_tag="next"
    ;;
esac

if [ "${event_name}" = "push" ]; then
  current_tag="$(git describe --tags --exact-match 2>/dev/null || true)"
  if [ -z "${current_tag}" ]; then
    echo "Push mode requires HEAD to be exactly on a tag like cli-v<version>." >&2
    exit 1
  fi
  tag_version="${current_tag#cli-v}"
  if [ "${tag_version}" != "${package_version}" ]; then
    echo "Tag version ${tag_version} does not match package version ${package_version}." >&2
    exit 1
  fi
  publish_tag="${default_tag}"
else
  if [ -n "${input_version}" ] && [ "${input_version}" != "${package_version}" ]; then
    echo "Workflow input version ${input_version} does not match package version ${package_version}." >&2
    exit 1
  fi
  if [ -n "${input_npm_tag}" ]; then
    publish_tag="${input_npm_tag}"
  else
    publish_tag="${default_tag}"
  fi
fi

echo "==> Resolved publish inputs"
echo "package_version=${package_version}"
echo "publish_tag=${publish_tag}"

echo "==> npm publish --dry-run --tag ${publish_tag}"
(
  cd packages/cli
  npm publish --dry-run --tag "${publish_tag}"
)

