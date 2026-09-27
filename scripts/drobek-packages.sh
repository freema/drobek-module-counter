#!/bin/sh
# Builds the @drobek/modules and @drobek/sdk tarballs that package-lock.json
# pins (file:.drobek-npm/…) while they are not on the npm registry: a shallow
# clone of freema/drobek at DROBEK_REF, `pnpm build:packages`, drobek's own
# npm pack step. CI runs it before `npm ci`.
#
#   npm run drobek:packages                        # clone + build → .drobek-npm/
#   DROBEK_DIR=../drobek npm run drobek:packages   # an existing checkout at that tag instead of a clone
#
# Once @drobek/* is on npm: rm package-lock.json && npm install (this script
# and the file: pins go away).
set -eu
cd "$(dirname "$0")/.."
REF="${DROBEK_REF:-v0.2.1}"
VERSION="${REF#v}"
OUT="$PWD/.drobek-npm"

if [ -f "$OUT/drobek-modules-$VERSION.tgz" ] && [ -f "$OUT/drobek-sdk-$VERSION.tgz" ]; then
  echo "$OUT already has the $VERSION tarballs"
  exit 0
fi

if [ -n "${DROBEK_DIR:-}" ]; then
  SRC="$(cd "$DROBEK_DIR" && pwd)"
else
  SRC="$PWD/.drobek/drobek-$VERSION"
  if [ ! -d "$SRC/.git" ]; then
    rm -rf "$SRC"
    git clone --quiet --depth 1 --branch "$REF" https://github.com/freema/drobek.git "$SRC"
  fi
fi

command -v pnpm >/dev/null 2>&1 || corepack enable
(cd "$SRC" && pnpm install --frozen-lockfile && pnpm build:packages)
mkdir -p "$OUT"
(cd "$SRC" && node scripts/npm-packages.mjs pack --version "$VERSION" --out "$OUT")
ls -l "$OUT"/*.tgz
