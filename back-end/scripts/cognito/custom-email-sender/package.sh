#!/bin/sh
set -eu
cd "$(dirname "$0")"
npm ci --omit=dev
mkdir -p dist
rm -f dist/sender.zip
zip -q -r dist/sender.zip index.mjs sender.mjs node_modules package.json
printf 'Package: %s/dist/sender.zip\n' "$PWD"
