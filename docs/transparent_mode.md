# Plan: Add Transparency Mode to projectM

## Goal
Add a UI button that toggles a "transparency mode." When enabled, all near-black pixels in the rendered output are written with `alpha = 0.0`, allowing an HTML `<img>` or `<video>` element placed behind the WebGL canvas to show through.

## Context
- `ProjectM::RenderFrame()` is the core render loop (`src/libprojectM/ProjectM.cpp`).
- Final output is drawn in two ways:
  1. **Normal frames**: `CopyTexture::Draw()` copies the preset texture to the target framebuffer using a simple textured-quad shader.
  2. **Transitions**: `PresetTransition::Draw()` renders directly to the target framebuffer using a built-in transition shader.
- The web frontend (`html/projectm-core.html`) uses two canvases: `#mcanvas` (z-index 3001, WebGL context with `alpha=true`) and `#scanvas` (z-index 3000, opaque black). The main render target is `#mcanvas`.
- The C API is exposed to JavaScript via Emscripten `EXPORTED_FUNCTIONS` and called with `Module.ccall()`.

## Approach: Shader-Based Transparency

Modify the final-output shaders (`CopyTexture` and transition shaders) to conditionally replace near-black pixels with transparent black (`vec4(0,0,0,0)`). This is GPU-accelerated, adds no extra framebuffer, and covers both normal frames and preset transitions.

### Step-by-Step Implementation

#### 1. Core C++ Engine (`src/libprojectM/ProjectM.hpp` & `ProjectM.cpp`)
- Add `bool m_transparencyMode{false};` private member to `ProjectM`.
- Add public methods:
  - `void SetTransparencyMode(bool enabled);`
  - `bool TransparencyMode() const;`
- In `ProjectM::RenderFrame()`, pass `m_transparencyMode` to:
  - `m_textureCopier->Draw(...)` (normal frames)
  - `m_transition->Draw(...)` (transition frames)

#### 2. CopyTexture Shader (`src/libprojectM/Renderer/CopyTexture.hpp` & `CopyTexture.cpp`)
- Add `bool transparencyMode = false` parameter to the `Draw()` overload used by `ProjectM::RenderFrame()`.
- Update the fragment shader source to include `uniform int u_transparencyEnabled;`.
- In the shader's `main()`:
  ```glsl
  vec4 texColor = texture(texture_sampler, fragment_tex_coord);
  if (u_transparencyEnabled > 0) {
      float maxComponent = max(max(texColor.r, texColor.g), texColor.b);
      if (maxComponent < 0.01) {
          texColor = vec4(0.0, 0.0, 0.0, 0.0);
      }
  }
  color = texColor;
  ```
- In `CopyTexture::Copy()`, bind and set the `u_transparencyEnabled` uniform before drawing the mesh.

#### 3. Transition Shaders (`src/libprojectM/Renderer/PresetTransition.hpp`, `PresetTransition.cpp`, and transition shader resources)
- Add `void SetTransparencyMode(bool enabled);` and `bool m_transparencyMode{false};` to `PresetTransition`.
- In `PresetTransition::Draw()`, set `u_transparencyEnabled` uniform on `m_transitionShader`.
- In `TransitionShaderHeaderGlsl330.frag`, add:
  ```glsl
  uniform int u_transparencyEnabled;
  ```
- In `TransitionShaderMainGlsl330.frag`, modify the final output:
  ```glsl
  vec3 finalColor = _user_out_color.xyz + _prjm_tpd_dither(gl_FragCoord.xy);
  float alpha = 1.0;
  if (u_transparencyEnabled > 0) {
      float maxComponent = max(max(finalColor.r, finalColor.g), finalColor.b);
      if (maxComponent < 0.01) {
          alpha = 0.0;
      }
  }
  _prjm_transition_out = vec4(finalColor, alpha);
  ```

#### 4. C API (`src/api/include/projectM-4/parameters.h` & `src/libprojectM/ProjectMCWrapper.cpp`)
- In `parameters.h`, add declarations:
  ```c
  PROJECTM_EXPORT void projectm_set_transparency_mode(projectm_handle instance, bool enabled);
  PROJECTM_EXPORT bool projectm_get_transparency_mode(projectm_handle instance);
  ```
- In `ProjectMCWrapper.cpp`, implement thin wrappers that call `ProjectM::SetTransparencyMode()` and `ProjectM::TransparencyMode()`.

#### 5. Emscripten Wrapper (`projectM_emscripten.cpp`)
- Add a simplified wrapper (matching the existing pattern for `set_preset_locked`, etc.):
  ```cpp
  extern "C" {
  EMSCRIPTEN_KEEPALIVE
  void set_transparency_mode(bool enabled) {
      if (!pm) return;
      projectm_set_transparency_mode(pm, enabled);
  }
  } // extern "C"
  ```

#### 6. Build Scripts (`scripts/build_projectm.sh` & `scripts/colab_build.sh`)
- Add `_set_transparency_mode` to the `-s EXPORTED_FUNCTIONS=...` list so the JavaScript bridge can call it.

#### 7. Web Frontend (`html/projectm-core.html`)
- Add a new control button inside the `#ui-overlay` div:
  ```html
  <button id="transparencyBtn" class="control-btn" style="background-color:magenta;left:3%;bottom:75%;">
      <span class="btn-label">Transparency Mode</span>
  </button>
  ```
- Add a background element (e.g., `<video id="bg-video" ...>`) with `z-index: 2999` placed between `#scanvas` (3000) and `#mcanvas` (3001).
- Add JavaScript logic:
  - Track `let isTransparencyMode = false;`
  - On button click, toggle `isTransparencyMode`.
  - Call `Module.ccall('set_transparency_mode', null, ['number'], [isTransparencyMode ? 1 : 0])`.
  - Toggle `#scanvas.style.display` between `'none'` (when transparent) and `'block'` (when opaque) so the background element is visible.
  - Update button label/color to indicate active state.

### Design Notes
- **Threshold**: `0.01` handles floating-point noise and dithering while treating true black as transparent. Tune at runtime via `projectm_set_transparency_threshold()` / `set_transparency_threshold()` (WASM).
- **Premultiplied Alpha**: The WebGL context already uses `premultipliedAlpha = EM_TRUE`. For black pixels, RGB is near-zero, so premultiplication does not alter the color.
- **Why not `discard`**: Using `discard` in fragment shaders can hurt performance on tile-based GPUs and may leave previous-frame pixels visible if the drawing buffer is not cleared. Explicitly writing `vec4(0,0,0,0)` is safer.
- **No extra FBO**: This approach avoids an intermediate framebuffer and extra render pass, keeping the change minimal and performant.

### Dual-FBO transitions
Preset rendering still uses the existing dual ping-pong FBO pair inside each `MilkdropPreset`. Transparency is applied only on the **final** blit to the default framebuffer:

1. **Normal frames** — `CopyTexture::Draw()` writes near-black pixels with `alpha = 0` when transparency mode is on.
2. **Soft transitions** — `PresetTransition` applies the same rule in `TransitionShaderMainGlsl330.frag`. For **multi-pass** transition shaders, pass 0 (intermediate FBO) keeps opaque alpha so pass 1 can sample a full RGB buffer; transparency is enabled only on the final pass draw.
3. **Internal copies** — `CopyTexture` burn-in / flip paths leave `u_transparencyEnabled = 0` so preset textures are not corrupted.

The WASM dual-FBO transition API (`dual_fbo_*`) is unchanged; hosts that composite externally should enable transparency mode on the engine before the final `render_frame` / default-FBO present.

### Demo (`html/projectm-core.html`)
- Background image `#bg-media` sits at `z-index: 2999` (between `#scanvas` and `#mcanvas`).
- Panel button **Glass transparency** toggles engine transparency mode and hides the black `#scanvas` underlay.
- URL: `?transparent=1` enables on load (persisted in `localStorage` as `projectm:transparencyMode`).

![Transparency mode demo](images/transparent-mode-demo.png)
