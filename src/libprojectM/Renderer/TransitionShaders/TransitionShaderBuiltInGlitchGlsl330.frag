// Glitch transition — RGB channel split + horizontal displacement driven by noise.
// 2-pass implementation:
// Pass 0: displaced crossfade between presets using blend library (B3 integration).
// Pass 1: chromatic aberration + RGB bleed + scanlines + block corruption on iLastPassTex.

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

    // Horizontal displacement
    float shift = (noise - 0.5) * glitchStrength;

    if (iPass == 0)
    {
        // ================================================================
        // Pass 0 — Displaced Crossfade (using blend library)
        // ================================================================
        float shiftR = shift * (1.0 + noise2 * 0.5);
        float shiftB = shift * (1.0 - noise2 * 0.5);

        vec2 uvR = clamp(uv + vec2(shiftR, 0.0), 0.0, 1.0);
        vec2 uvG = clamp(uv + vec2(shift, 0.0), 0.0, 1.0);
        vec2 uvB = clamp(uv + vec2(shiftB, 0.0), 0.0, 1.0);

        vec3 oldR = texture(iChannel0, uvR).rgb;
        vec3 newR = texture(iChannel1, uvR).rgb;
        vec3 oldG = texture(iChannel0, uvG).rgb;
        vec3 newG = texture(iChannel1, uvG).rgb;
        vec3 oldB = texture(iChannel0, uvB).rgb;
        vec3 newB = texture(iChannel1, uvB).rgb;

        // Per-channel crossfade
        float r = mix(oldR.r, newR.r, progress);
        float g = mix(oldG.g, newG.g, progress);
        float b = mix(oldB.b, newB.b, progress);

        vec4 oldColor = vec4(r, g, b, 1.0);
        vec4 newColor = vec4(r, g, b, 1.0); // already mixed per channel

        vec4 blended;
        if (iBlendMode == 0)      blended = blendAlpha(oldColor, newColor, progress);
        else if (iBlendMode == 1) blended = blendAdditive(oldColor, newColor, progress);
        else if (iBlendMode == 2) blended = blendMultiplicative(oldColor, newColor, progress);
        else if (iBlendMode == 3) blended = blendScreen(oldColor, newColor, progress);
        else                      blended = blendAlpha(oldColor, newColor, progress);

        fragColor = blended;
        return;
    }
    else
    {
        // ================================================================
        // Pass 1 — Chromatic Aberration + RGB Bleed + Scanlines + Block Corruption
        // ================================================================
        vec3 col = texture(iLastPassTex, uv).xyz;

        // Chromatic aberration / RGB bleed on top of blended result
        float bleed = glitchStrength * 0.018;
        col.r = mix(col.r, texture(iLastPassTex, uv + vec2(bleed, 0.0)).r, 0.45 * glitchStrength);
        col.b = mix(col.b, texture(iLastPassTex, uv - vec2(bleed, 0.0)).b, 0.45 * glitchStrength);

        // Random horizontal block corruption
        float blockNoise = hash(vec2(floor(uv.y * 12.0), float(iRandFrame.z)));
        float blockMask = step(0.85 - glitchStrength * 0.3, blockNoise) * glitchStrength;
        vec3 blockColor = texture(iLastPassTex, vec2(fract(uv.x + shift * 2.0), uv.y)).xyz;
        col = mix(col, blockColor, blockMask * 0.6);

        // Scanline darkening
        float scanline = sin(uv.y * 800.0) * 0.04 * glitchStrength;
        col -= scanline;

        // Brief white flash at peak glitch
        float flash = smoothstep(0.45, 0.5, progress) * (1.0 - smoothstep(0.5, 0.55, progress));
        col = mix(col, vec3(1.0), flash * glitchStrength * 0.12);

        fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        return;
    }
}