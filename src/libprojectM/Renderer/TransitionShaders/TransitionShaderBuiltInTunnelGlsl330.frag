// Tunnel — the Milkdrop "fly into the tunnel" transition (Phase B5). The old
// preset recedes down a swirling tunnel while the new preset rushes out of the
// vanishing point toward the viewer.
//
// Classic Milkdrop gets the smear from video feedback (re-sampling the previous
// frame). A transition shader has no frame history, so the trail is rebuilt every
// frame from a fixed set of zoom taps — visually equivalent for the length of a
// transition, and it costs no extra render target. True frame-feedback tunnels
// remain intentionally deferred (see docs/option_b_milkdrop_parity.md).
//
// 2-pass implementation:
//   Pass 0: accumulate the zoom/rotate trail for both presets and cross-blend.
//   Pass 1: radial chromatic aberration, tunnel-mouth glow, streaks and vignette.

const int _TUNNEL_TAPS = 8;

vec2 _tunnel_warp(vec2 centered, float scale, float angle, float aspect)
{
    float s = sin(angle);
    float c = cos(angle);
    vec2 rotated = vec2(centered.x * c - centered.y * s,
                        centered.x * s + centered.y * c);
    rotated *= scale;
    rotated.x /= aspect;
    return rotated + 0.5;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    float p = iProgressEased;

    float aspect = iAspectX / max(iAspectY, 0.0001);

    float bassPump = clamp(iBassAtt, 0.0, 2.0);
    float trebPump = clamp(iTrebAtt, 0.0, 2.0);

    // Off-center vanishing points make repeat plays feel different.
    vec2 pivot = vec2(0.5 + (mod(float(iRandStatic.x & 255), 100.0) / 100.0 - 0.5) * 0.24,
                      0.5 + (mod(float(iRandStatic.y & 255), 100.0) / 100.0 - 0.5) * 0.24);

    // Swirl direction and strength, also randomized per transition.
    float swirlDir = ((iRandStatic.z & 1) == 0) ? 1.0 : -1.0;
    float swirl = swirlDir * (0.6 + mod(float(iRandStatic.w & 255), 100.0) / 100.0 * 1.4);

    vec2 centered = uv - pivot;
    centered.x *= aspect;
    float radius = length(centered);

    if (iPass == 0)
    {
        // ================================================================
        // Pass 0 — Zoom trail accumulation and cross-blend
        // ================================================================

        vec3 oldAcc = vec3(0.0);
        vec3 newAcc = vec3(0.0);
        float weightSum = 0.0;

        for (int i = 0; i < _TUNNEL_TAPS; ++i)
        {
            float f = float(i) / float(_TUNNEL_TAPS - 1); // 0..1 along the trail

            // Older taps sit deeper in the tunnel: larger sample scale shrinks the
            // image toward the vanishing point.
            float oldScale = 1.0 + (p * 2.6 + f * 0.9) * (1.0 + 0.15 * bassPump);
            float oldAngle = (p * 1.15 + f * 0.35) * swirl;

            // The new preset starts deep and rushes outward as progress advances.
            float newScale = 1.0 + ((1.0 - p) * 3.2 + f * 0.9) * (1.0 + 0.15 * bassPump);
            float newAngle = -((1.0 - p) * 1.15 + f * 0.35) * swirl;

            vec2 oldUV = _tunnel_warp(centered, oldScale, oldAngle, aspect);
            vec2 newUV = _tunnel_warp(centered, newScale, newAngle, aspect);

            // Trailing taps contribute less, producing the feedback-style smear.
            float weight = exp(-f * 2.2);

            oldAcc += texture(iChannel0, clamp(oldUV, 0.0, 1.0)).xyz * weight;
            newAcc += texture(iChannel1, clamp(newUV, 0.0, 1.0)).xyz * weight;
            weightSum += weight;
        }

        oldAcc /= max(weightSum, 0.0001);
        newAcc /= max(weightSum, 0.0001);

        // The new preset takes over from the middle of the tunnel outward, so the
        // hand-off happens at the vanishing point rather than across the frame.
        float handoff = clamp(p * 1.35 - radius * 0.45, 0.0, 1.0);
        vec3 col = prjmBlendPresets(oldAcc, newAcc, handoff);

        fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        return;
    }
    else
    {
        // ================================================================
        // Pass 1 — Chromatic aberration, tunnel glow, streaks and vignette
        // ================================================================

        // Radial chromatic aberration: strongest at the frame edges, peaking at
        // the middle of the transition where apparent speed is highest.
        float speed = sin(p * 3.14159265);
        vec2 radialDir = radius > 0.0001 ? centered / radius : vec2(0.0);
        vec2 aberration = radialDir * (0.004 + 0.010 * speed) * radius;
        aberration.x /= aspect;

        vec3 col = vec3(
            texture(iLastPassTex, clamp(uv + aberration, 0.0, 1.0)).r,
            texture(iLastPassTex, uv).g,
            texture(iLastPassTex, clamp(uv - aberration, 0.0, 1.0)).b
        );

        // Motion streaks along the radial direction — a few extra taps outward
        // reinforce the sense of flying through the tunnel.
        vec3 streak = vec3(0.0);
        for (int i = 1; i <= 4; ++i)
        {
            vec2 offset = radialDir * float(i) * (0.008 + 0.012 * speed);
            offset.x /= aspect;
            streak += texture(iLastPassTex, clamp(uv + offset, 0.0, 1.0)).xyz;
        }
        streak *= 0.25;
        col = mix(col, streak, 0.22 * speed);

        // Glowing tunnel mouth at the vanishing point, pumped by bass.
        float mouth = exp(-radius * radius * 22.0);
        col += vec3(0.55, 0.70, 1.0) * mouth * speed * (0.28 + 0.30 * bassPump);

        // Treble sparkle on the mouth rim.
        float rim = exp(-pow(radius - 0.18, 2.0) * 180.0);
        col += vec3(0.7, 0.8, 1.0) * rim * speed * 0.15 * trebPump;

        // Vignette that tightens with apparent speed.
        float vignette = 1.0 - radius * radius * (0.35 + 0.35 * speed);
        col *= clamp(vignette, 0.0, 1.0);

        fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
        return;
    }
}
