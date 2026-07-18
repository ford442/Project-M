// Glitch transition — RGB channel split + horizontal displacement driven by noise and randomness.
// 2-pass implementation:
//   Pass 0: displaced crossfade between presets (base glitch geometry).
//   Pass 1: chromatic aberration, scanlines, and block corruption on iLastPassTex.

float hash(vec2 p)
{
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    float progress = iProgressEased;

    // Randomize glitch intensity and frequency
    float intensity = mod(float(iRandStatic.x) * 0.001, 0.3) + 0.1;
    float freq = mod(float(iRandStatic.y) * 0.01, 20.0) + 10.0;

    // Animated noise using frame random for jitter
    float noise = hash(vec2(floor(uv.y * freq), float(iRandFrame.x)));
    float noise2 = hash(vec2(floor(uv.y * freq * 0.5), float(iRandFrame.y)));

    // Glitch is strongest in the middle of the transition; bass kicks add punch.
    float bassPump = clamp(iBassAtt, 0.0, 2.0);
    float glitchStrength = intensity * sin(progress * 3.14159265) * (1.0 + 0.6 * bassPump);

    // Horizontal displacement
    float shift = (noise - 0.5) * glitchStrength;

    if (iPass == 0)
    {
        // ================================================================
        // Pass 0 — Displaced Crossfade
        // ================================================================

        vec2 uvShift = clamp(uv + vec2(shift, 0.0), 0.0, 1.0);

        vec3 oldImg = texture(iChannel0, uvShift).xyz;
        vec3 newImg = texture(iChannel1, uvShift).xyz;

        // Use blend library for the base crossfade (B3 integration).
        vec4 oldColor = vec4(oldImg, 1.0);
        vec4 newColor = vec4(newImg, 1.0);
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
        // Pass 1 — Chromatic Split, Scanlines, Block Corruption
        // ================================================================

        float shiftR = shift * (1.0 + noise2 * 0.5);
        float shiftB = shift * (1.0 - noise2 * 0.5);

        vec2 uvR = clamp(uv + vec2(shiftR, 0.0), 0.0, 1.0);
        vec2 uvG = clamp(uv + vec2(shift,  0.0), 0.0, 1.0);
        vec2 uvB = clamp(uv + vec2(shiftB, 0.0), 0.0, 1.0);

        float r = texture(iLastPassTex, uvR).r;
        float g = texture(iLastPassTex, uvG).g;
        float b = texture(iLastPassTex, uvB).b;

        // Scanline darkening
        float scanline = sin(uv.y * 800.0) * 0.04 * glitchStrength;

        // Random horizontal block corruption at peak glitch.
        float blockNoise = hash(vec2(floor(uv.y * 12.0), float(iRandFrame.z)));
        float blockMask = step(0.85 - glitchStrength * 0.3, blockNoise) * glitchStrength;
        vec3 blockColor = texture(iLastPassTex, vec2(fract(uv.x + shift * 2.0), uv.y)).xyz;
        vec3 col = vec3(r - scanline, g - scanline, b - scanline);
        col = mix(col, blockColor, blockMask * 0.6);

        fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        return;
    }
}
