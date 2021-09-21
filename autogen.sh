#!/usr/bin/env sh

set -e

printf 'Running  autoreconf --install  ...'

autoreconf --install

printf '\nSuccess!\nNow please run:  emconfigure ./configure  \n'
