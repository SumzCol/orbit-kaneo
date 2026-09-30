#!/usr/bin/env bash
set -euo pipefail

# The standard GitHub latest release excludes prereleases and package-only releases.
# A repository that has published none, or whose newest one is a package release
# such as planka-import-v0.2.0, has no baseline to upgrade from. That is the
# normal state of a fork, so the check reports itself skipped rather than failing
# on a tag it was never meant to read.
tag=$(gh api "repos/$GITHUB_REPOSITORY/releases/latest" --jq .tag_name 2>/dev/null) || tag=""
if [[ ! "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "No stable vX.Y.Z release on $GITHUB_REPOSITORY (latest: ${tag:-none}); skipping the upgrade check."
  exit 0
fi
version=${tag#v}
node scripts/security/validate-release-version.mjs "$version" --new-version
owner=$(printf '%s' "$GITHUB_REPOSITORY_OWNER" | tr '[:upper:]' '[:lower:]')
image="ghcr.io/$owner/kaneo:$version"
docker pull "$image"
# Record and use the pulled digest so a mutable tag cannot change the baseline mid-test.
export KANEO_UPGRADE_IMAGE
authoritative_ref=$(docker image inspect "$image" --format '{{index .RepoDigests 0}}')
KANEO_UPGRADE_IMAGE=$authoritative_ref
mkdir -p .cache/ci-results
printf 'Upgrade baseline: %s\n' "$KANEO_UPGRADE_IMAGE" | tee .cache/ci-results/upgrade-baseline.txt
compose=(docker compose --env-file /dev/null -p kaneo-ci -f scripts/ci/compose.yml --profile upgrade)
"${compose[@]}" up -d --wait --wait-timeout 120 upgrade
node scripts/ci/upgrade.mjs seed http://127.0.0.1:55175 .cache/ci-results/upgrade-state.json
"${compose[@]}" stop upgrade
export KANEO_UPGRADE_IMAGE=kaneo:ci
"${compose[@]}" up -d --no-deps --wait --wait-timeout 120 --force-recreate upgrade
node scripts/ci/upgrade.mjs verify http://127.0.0.1:55175 .cache/ci-results/upgrade-state.json
