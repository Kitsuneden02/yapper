#!/usr/bin/env sh
# Genera dist/yapper.zip con solo lo que necesita la extensión, a partir del último commit.
# Al descomprimirlo queda una carpeta «yapper/» lista para «Cargar extensión sin empaquetar».
set -e
cd "$(dirname "$0")/.."
mkdir -p dist
git archive --format=zip --prefix=yapper/ -o dist/yapper.zip HEAD \
  manifest.json background.js content editor icons LICENSE
echo "Creado dist/yapper.zip (versión $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json))"
