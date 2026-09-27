#!/bin/sh
# Re-pins @drobek/modules and @drobek/sdk in package-lock.json to the tarballs
# in .drobek-npm/ (npm run drobek:packages) — after a new DROBEK_REF, i.e. a
# new version and integrity. package.json keeps the registry range, so the
# published manifest never names a file: path.
#
# Once @drobek/* is on npm: rm package-lock.json && npm install
set -eu
cd "$(dirname "$0")/.."
REF="${DROBEK_REF:-v0.2.1}"
VERSION="${REF#v}"
MODULES=".drobek-npm/drobek-modules-$VERSION.tgz"
SDK=".drobek-npm/drobek-sdk-$VERSION.tgz"
for f in "$MODULES" "$SDK"; do
  [ -f "$f" ] || { echo "missing $f — run npm run drobek:packages first" >&2; exit 1; }
done
cp package.json package.json.bak
trap 'mv package.json.bak package.json' EXIT
rm -rf node_modules package-lock.json
npm install --no-audit --no-fund --save-dev "./$MODULES" "./$SDK"
mv package.json.bak package.json
trap - EXIT
npm install --no-audit --no-fund
echo "package-lock.json pins @drobek/modules + @drobek/sdk $VERSION to .drobek-npm/; package.json keeps the registry range."
