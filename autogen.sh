#!/usr/bin/env sh

set -e # Drop-out from execution if error occurs

printf 'Running autoreconf...'

libtoolize
aclocal
automake --add-missing
autoconf

autoreconf --install

printf '\nSuccess!\nNow please run: emconfigure ./configure\n'
