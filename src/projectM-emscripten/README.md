Running on the web.

## Prepare
* Activate the emsdk (https://github.com/juj/emsdk#installation-instructions)
* Make sure you are in the root directory of this project
* On fresh repositories: `./autogen.sh`

## Compile
* `emconfigure ./configure`
* `emmake make`

## Create wasm & html files
* `cd src/projectM-emscripten`
* `make run`

## Troubleshooting

### General

Want to restart the process after pulling or changing config?
* `rm src/projectM-emscripten/projectW*`
* restart with emconfigure or emmake

### OS X troubleshooting:

#### `./autogen.sh: line 3: autoreconf: command not found`
fix via `brew install automake`
