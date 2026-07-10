# Experimental presets

Presets in this directory are **opt-in demos** for B3HD advanced hooks (depth maps, glTF,
etc.). They are **not** part of the default `PresetCompat` / `custom_milk_fixed` regression
set.

| File | Role |
|------|------|
| `depth_overlay_demo.milk` | `shapecode` textured with `pm_depth_map.png` from the experimental bridge |
| `gltf_export_flag_demo.milk` | Sets `// pm:experimental gltf-export=true` (host coordinator only) |

Load via:

```
html/projectm-core.html?experimental=1&devPreset=1&localPresets=1
```

Then open the purple **Experimental preset hooks** panel (bottom-right): load depth AI,
upload an image or capture canvas, wait for / bind the depth result, and load one of these
presets from the local file picker or dev panel.

See [`docs/EXPERIMENTAL_PRESET_HOOKS.md`](../../docs/EXPERIMENTAL_PRESET_HOOKS.md).
