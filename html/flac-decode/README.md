# FLAC decode player (`projectm.1ink.us/flac`)

Browser-side **FLAC → WAV** converter used by the projectM host via `BroadcastChannel('file')`.
Built on [libflac.js](https://github.com/mmig/libflac.js) (WASM); the `dist/` libflac binaries are
deployed separately on the server and are not vendored in this repo.

## Layout

| Path | Role |
|------|------|
| `example/decode-func.js` | libFLAC decode wrapper; returns `metaData` + `streamInfo` |
| `example/app-decode.js` | UI handler; exports WAV using decoded stream format |
| `example/util/data-util.js` | WAV interleave/encode helpers (`exportWavFile`) |
| `example/util/download-util.js` | Download helpers |
| `example/util/file-handler.js` | Drag/drop + file input wiring |

The live page shell (`index.html`, `example/util/setup.1ijs`, `dist/libflac.*`) lives on
`https://projectm.1ink.us/flac/` and loads these scripts from `./example/`.

## Stream format

`exportWavFile()` must receive `sampleRate`, `channels`, and `bitsPerSample` from the decoded
FLAC stream (STREAMINFO metadata, with per-frame `frameHdr` as fallback). Hard-coding 44100 Hz /
stereo / 24-bit breaks 16-bit and other common rips.

After editing, sync `html/flac-decode/example/` to the server's `/flac/example/` tree.
