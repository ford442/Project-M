// WasmCompositorShader.hpp
//
// GLSL of the dual-FBO compositor (CompositingBlendShader in WasmGraphics.hpp):
// plain strings with no Emscripten dependency, so tests/libprojectM compiles
// and runs the same source natively (ColorOutputTest.cpp).
#pragma once

// GLSL ES 3.00 vertex shader: maps NDC positions and derives UV coords.
inline constexpr char kCompositorVertexShader[] = R"(#version 300 es
in vec2 aPosition;
out vec2 vTexCoord;
void main() {
    vTexCoord = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
)";

// GLSL ES 3.00 fragment shader: blends two textures with mix().
//
// uDither is set to 1.0 only when the dual-FBO source textures are GL_RGBA8
// (FboFloatFormat::RGBA8): an ordered dither hides the extra quantization of
// that intermediate copy. It cannot add back precision the frame never had:
// libprojectM renders its feedback, warp and composite targets in RGBA8 in the
// WASM build, so the frame reaching these textures is already 8-bit.
//
// Alpha. The canvas is opaque by default (contextAlpha off), which makes the
// alpha written here irrelevant. With transparency mode on the canvas has an
// alpha channel and premultipliedAlpha, where a pixel with rgb > a is invalid
// and composites differently per browser (brightened on Chrome, clamped on
// Safari). So:
//  - transparency off: alpha is 1. A preset's alpha channel is blend-mode
//    leftovers, not coverage.
//  - transparency on: the engine's own transparency pass already wrote
//    premultiplied pixels, opaque or (0, 0, 0, 0), and a crossfade mixes those
//    into partial coverage that is still premultiplied. Multiplying by alpha
//    again would darken partially covered pixels twice; the colour is clamped
//    to the alpha instead, which the dither could otherwise push past it.
//
// Output is display-referred sRGB-like RGB written to a canvas tagged
// drawingBufferColorSpace="srgb" (see ProjectMApplySrgbCanvasColorSpace).
// Do not reinterpret these numbers as Display-P3 without a convert.
inline constexpr char kCompositorFragmentShader[] = R"(#version 300 es
precision highp float;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform float uBlend;
uniform float uDither;
uniform int u_transparencyEnabled;
uniform float u_transparencyThreshold;
in vec2 vTexCoord;
out vec4 fragColor;

// 4x4 Bayer ordered-dither matrix, normalized to [-0.5, 0.5] / 255.
const float kBayer[16] = float[16](
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
);

void main() {
    vec4 colorA = texture(uTexA, vTexCoord);
    vec4 colorB = texture(uTexB, vTexCoord);
    vec4 color = mix(colorA, colorB, uBlend);

    if (uDither > 0.5) {
        ivec2 p = ivec2(mod(gl_FragCoord.xy, 4.0));
        float threshold = (kBayer[p.y * 4 + p.x] / 16.0 - 0.5) / 255.0;
        color.rgb += threshold;
    }

    color = clamp(color, 0.0, 1.0);

    if (u_transparencyEnabled > 0) {
        float maxComponent = max(max(color.r, color.g), color.b);
        if (maxComponent < u_transparencyThreshold) {
            color = vec4(0.0);
        }
        fragColor = vec4(min(color.rgb, vec3(color.a)), color.a);
    } else {
        fragColor = vec4(color.rgb, 1.0);
    }
}
)";
