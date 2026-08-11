#!/usr/bin/env bash
# Assembles the static client (public/ + shared/) and force-pushes it to the
# gh-pages branch, which GitHub Pages serves at https://<owner>.github.io/signal/
#
# The Pages build has no game server, so it runs in pass-and-play mode; it can
# also connect to a hosted server via ?server=wss://…
#
# To automate this on every push to main instead, copy docs/pages-workflow.yml
# to .github/workflows/pages.yml (needs credentials with workflow scope) and
# switch Settings → Pages → Source to "GitHub Actions".
set -euo pipefail

root=$(git rev-parse --show-toplevel)
origin=$(git -C "$root" remote get-url origin)
site=$(mktemp -d)
trap 'rm -rf "$site"' EXIT

cp "$root"/public/* "$site"/
mkdir -p "$site/shared"
cp "$root"/shared/*.js "$site/shared/"
touch "$site/.nojekyll"

git -C "$site" init -q -b gh-pages
git -C "$site" add -A
git -C "$site" -c user.name="pages-deploy" -c user.email="noreply@localhost" \
  commit -q -m "Deploy SIGNAL DOMINION static build ($(git -C "$root" rev-parse --short HEAD))"
git -C "$site" push -f "$origin" gh-pages

echo "gh-pages updated."
