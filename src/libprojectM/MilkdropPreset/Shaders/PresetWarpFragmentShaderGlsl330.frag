in vec4 frag_COLOR;
in vec4 frag_TEXCOORD0;
in vec2 frag_TEXCOORD1;

uniform sampler2D texture_sampler;
// Set to 1 when the main texture is NOT pre-flipped (i.e. when the default
// warp path skips the pre-warp CopyTexture flip pass for performance).
// The fragment shader then flips the V sampling coordinate at no extra cost,
// while still writing the un-flipped UV to the motion-vector attachment so
// that motion arrows remain visually correct.
uniform int u_flipMainTex;

layout(location = 0) out vec4 color;
layout(location = 1) out vec2 texCoords;

// Triangular-PDF dither applied to the feedback texture write.
// Whitens quantization noise in the 8-bit temporal loop (SDR) or is negligible
// in float16 (HDR). Tone-mapping/gamma-encode is intentionally NOT done here —
// the warp output feeds back into the next frame's texture sampler and must
// remain in linear light so that decay/fade math is physically correct.
float tpdDither(vec2 fc) {
    float r1 = fract(sin(dot(fc, vec2(12.9898, 78.233))) * 43758.5453);
    float r2 = fract(sin(dot(fc, vec2(93.989,  67.345))) * 12345.678);
#ifdef PROJECTM_HDR_RENDERING
    return (r1 + r2 - 1.0) * (1.0 / 65535.0);
#else
    return (r1 + r2 - 1.0) * (1.0 / 255.0);
#endif
}

void main() {
    // When the previous-frame texture is supplied un-flipped, fold the vertical
    // flip into the sample coordinate so we can skip the pre-warp CopyTexture
    // pass entirely.  frag_TEXCOORD0.xy carries the Milkdrop UV (warp-math
    // space, v increases downward); flipping .y here is equivalent to sampling
    // the same texture after a vertical mirror blit.
    vec2 sampleCoord = frag_TEXCOORD0.xy;
    if (u_flipMainTex > 0) {
        sampleCoord.y = 1.0 - sampleCoord.y;
    }

    // Sample previous frame with decay applied (decay = frag_COLOR.rgb)
    color = frag_COLOR * texture(texture_sampler, sampleCoord);

    // Dither before quantization; keeps values linear for the feedback loop
    color.rgb += tpdDither(gl_FragCoord.xy);

    // Motion vector grid u/v coords for the next frame.
    // Always written in the un-flipped warp-UV space so motion arrows are
    // consistent regardless of whether the pre-flip pass ran.
    texCoords = frag_TEXCOORD0.xy;
}

