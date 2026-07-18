// Glitch transition — RGB channel split + horizontal displacement driven by noise.
// 2-pass implementation:
//   Pass 0: displacement + chromatic crossfade between presets.
//   Pass 1: scanlines, block corruption, and RGB bleed on top of pass 0.

float hash(vec2 p)
{
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    float progress = iProgressEased;

    float intensity = mod(float(iRandStatic.x) * 0.001, 0.3) + 0.1;
    float freq = mod(float(iRandStatic.y) * 0.01, 20.0) + 10.0;

    float noise = hash(vec2(floor(uv.y * freq), float(iRandFrame.x)));
    float noise2 = hash(vec2(floor(uv.y * freq * 0.5), float(iRandFrame.y)));

    float bassPump = clamp(iBassAtt, 0.0, 2.0);
    float glitchStrength = intensity * sin(progress * 3.14159265) * (1.0 + 0.6 * bassPump);

    if (iPass == 0)
    {
        // ================================================================
        // Pass 0 — Displacement + Chromatic Crossfade
        // ================================================================

        float shift = (noise - 0.5) * glitchStrength;
        float shiftR = shift * (1.0 + noise2 * 0.5);
        float shiftB = shift * (1.0 - noise2 * 0.5);

        vec2 uvR = clamp(uv + vec2(shiftR, 0.0), 0.0, 1.0);
        vec2 uvG = clamp(uv + vec2(shift,  0.0), 0.0, 1.0);
        vec2 uvB = clamp(uv + vec2(shiftB, 0.0), 0.0, 1.0);

        float r = texture(iChannel0, uvR).r * (1.0 - progress) + texture(iChannel1, uvR).r * progress;
        float g = texture(iChannel0, uvG).g * (1.0 - progress) + texture(iChannel1, uvG).g * progress;
        float b = texture(iChannel0, uvB).b * (1.0 - progress) + texture(iChannel1, uvB).b * progress;

        fragColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
        return;
    }
    else
    {
        // ================================================================
        // Pass 1 — Scanlines, Block Corruption, RGB Bleed
        // ================================================================

        vec3 col = texture(iLastPassTex, uv).xyz;

        // Horizontal RGB bleed — sample neighbors with channel offsets.
        float bleed = glitchStrength * 0.018;
        col.r = mix(col.r, texture(iLastPassTex, uv + vec2(bleed, 0.0)).r, 0.45 * glitchStrength);
        col.b = mix(col.b, texture(iLastPassTex, uv - vec2(bleed, 0.0)).b, 0.45 * glitchStrength);

        // Block corruption — quantize UV into tiles and jitter some blocks.
        float blockSize = 24.0 + freq * 0.5;
        vec2 blockUV = floor(uv * blockSize) / blockSize;
        float blockNoise = hash(blockUV + vec2(float(iRandFrame.z), float(iRandFrame.w)));
        if (blockNoise > 0.92 - glitchStrength * 0.15)
        {
            vec2 blockShift = vec2((hash(blockUV + 1.7) - 0.5) * 0.08 * glitchStrength, 0.0);
            col = texture(iLastPassTex, clamp(uv + blockShift, 0.0, 1.0)).xyz;
            col *= 0.85 + 0.15 * blockNoise;
        }

        // Scanline darkening.
        float scanline = sin(uv.y * 800.0) * 0.04 * glitchStrength;
        col -= scanline;

        // Brief white flash at peak glitch.
        float flash = smoothstep(0.45, 0.5, progress) * (1.0 - smoothstep(0.5, 0.55, progress));
        col = mix(col, vec3(1.0), flash * glitchStrength * 0.12);

        fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        return;
    }
}
