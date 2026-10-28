#!/usr/bin/env bash
# Publish packages/core/pi-core-todo from this monorepo to the standalone
# install repo Apothic-AI/pi-core-todo, so pi can install it by git URL
# instead of a local path:
#
#   pi install git:github.com/Apothic-AI/pi-core-todo@main
#
# The standalone repo is a `git subtree split` projection of this one — it is
# generated, never edited by hand. Always change the package here and re-run
# this script; a direct commit to Apothic-AI/pi-core-todo is overwritten.
#
# Usage: scripts/sync-pi-core-todo-repo.sh [branch]   (default: current branch)
set -euo pipefail

REPO_ROOT=$(git rev-parse --show-toplevel)
PREFIX=packages/core/pi-core-todo
REMOTE=https://github.com/Apothic-AI/pi-core-todo.git
BRANCH=${1:-$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)}
TMP_BRANCH=tmp/sync-pi-core-todo

if [ "$BRANCH" = "HEAD" ]; then
	echo "refusing to sync from a detached HEAD; check out a branch first" >&2
	exit 1
fi

cd "$REPO_ROOT"
git branch -D "$TMP_BRANCH" >/dev/null 2>&1 || true
# git subtree prints per-commit progress on stderr; keep it quiet, rely on exit status
git subtree split -P "$PREFIX" -b "$TMP_BRANCH" >/dev/null 2>&1

echo "split $BRANCH:$PREFIX -> $TMP_BRANCH $(git rev-parse --short "$TMP_BRANCH")"
git push --force "$REMOTE" "$TMP_BRANCH:main"
git branch -D "$TMP_BRANCH" >/dev/null
echo "published: https://github.com/Apothic-AI/pi-core-todo/commit/$(git ls-remote "$REMOTE" refs/heads/main | cut -f1)"
