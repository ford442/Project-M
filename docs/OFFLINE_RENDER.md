# Offline rendering

Rendering on a virtual clock instead of in real time: video export, golden images, render
farms. Two pieces:

- `projectm_render_offline_frame()` in `projectM-4/offline_render.h`, the library API.
- `projectm-render`, a headless command-line renderer built on it (`-DENABLE_RENDER_TOOL=ON`,
  Linux and the BSDs).

## The API

```c
projectm_handle pm = projectm_create();          /* with a GL context current */
projectm_set_seed(pm, 1);                         /* before the first preset */
projectm_set_window_size(pm, 1280, 720);
projectm_load_preset_file(pm, "preset.milk", false);

for (uint64_t frame = 0; frame < frames; frame++)
{
    /* this frame's interleaved stereo samples: [frame * rate / fps, (frame + 1) * rate / fps) */
    projectm_render_offline_frame(pm, samples, count, (double)frame / fps, fbo);
    /* read the pixels back from fbo */
}
```

Each call adds the frame's audio, sets the frame time and renders into `fbo`. Shaders compile
synchronously, so a preset loaded before a frame is drawn in that frame. The call returns
`false` and changes nothing if the time is negative, not finite or earlier than the previous
call's, or if `samples` is null with a non-zero count.

Two runs give identical pixels when they use the same seed, the same presets loaded at the same
frames, the same audio and frame times, and the same GPU and driver. The frame time drives
everything that would otherwise read the wall clock: preset durations, soft cuts, the
bass/mid/treb averages and the rhythm analysis. The engine's clock starts at exactly 0, so a
first frame at time 0 has a time step of 0. Before this was fixed, the constructor read the clock,
and a few microseconds of construction time made the audio averages differ from run to run.

Engines are independent (see `EngineContext`), so a render farm can run one engine per
thread, each on its own GL context, with different seeds.

## projectm-render

```sh
cmake -S . -B build -DENABLE_RENDER_TOOL=ON && cmake --build build
build/src/tools/projectm-render/projectm-render \
    --preset presets/tests/300-beatdetect-bassmidtreb.milk \
    --audio song.flac --seed 1 --output - |
  ffmpeg -f rawvideo -pix_fmt rgba -s 1280x720 -r 60 -i - -i song.flac -vf vflip out.mp4
```

| Option | Default | |
|---|---|---|
| `--preset FILE` | required | The preset; it stays locked for the whole render. |
| `--audio FILE` | silence | FLAC, WAV or MP3, decoded with the vendored dr_libs. Mono is duplicated; channels after the second are dropped. |
| `--duration SECS` | the audio's length, or 10 | |
| `--width`, `--height` | 1280x720 | |
| `--fps` | 60 | |
| `--seed` | 0 | |
| `--texture-path DIR` | none | Where presets find their textures. |
| `--output FILE` | none | Raw RGBA frames, bottom row first (hence `vflip`); `-` for stdout. |
| `--hash` | off | Prints `frames N fnv1a64 H` over every pixel (to stderr when frames go to stdout). |

It creates a surfaceless EGL context (`EGL_PLATFORM_SURFACELESS_MESA`), falling back to the
default display and a 1x1 pbuffer. No X server or window is needed, and Mesa's llvmpipe works.
A GLES build (`ENABLE_GLES`) asks for OpenGL ES 3.2, otherwise OpenGL 3.3 core.

`ProjectmRenderDeterministic` (ctest, `tests/tools/`) renders 10 s of
`tests/tools/data/beat-10s.flac` twice and fails unless the hashes match. It also fails if a
silent render gives the same hash, which shows that the hash covers audio-driven pixels. The
fixture is synthetic: a decaying 110 Hz kick every half second and a 660 Hz tone in the first
quarter of each second. `build_linux.yml` builds the tool and runs that test.
