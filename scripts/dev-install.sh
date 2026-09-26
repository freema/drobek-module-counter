#!/bin/sh
# Pins @drobek/modules and @drobek/sdk in package-lock.json to local tarballs
# while they are not on the npm registry. package.json keeps the registry range
# (^0.2.0), so the published manifest never names a file: path.
#
#   DROBEK_NPM_DIR=../drobek/dist-npm npm run dev:install-local
#
# Once @drobek/* is on npm: rm package-lock.json && npm install
set -eu
cd "$(dirname "$0")/.."
DIR="${DROBEK_NPM_DIR:-../drobek/dist-npm}"
MODULES="$DIR/drobek-modules-0.2.0.tgz"
SDK="$DIR/drobek-sdk-0.2.0.tgz"
for f in "$MODULES" "$SDK"; do
  [ -f "$f" ] || { echo "missing $f (build it in the drobek repo, or set DROBEK_NPM_DIR)" >&2; exit 1; }
done
cp package.json package.json.bak
trap 'mv package.json.bak package.json' EXIT
rm -rf node_modules/@drobek package-lock.json
npm install --no-audit --no-fund --save-dev "$MODULES" "$SDK"
mv package.json.bak package.json
trap - EXIT
npm install --no-audit --no-fund
echo "package-lock.json pins @drobek/modules + @drobek/sdk to $DIR; package.json keeps ^0.2.0."
