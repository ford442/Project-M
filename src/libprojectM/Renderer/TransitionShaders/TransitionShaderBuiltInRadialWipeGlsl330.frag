// RadialWipe — a classic Milkdrop-style clock wipe (Phase B5). A sweep hand rotates
// around a center point, revealing the new preset behind it like a radar sweep.
// A soft leading edge avoids hard aliasing, and a glowing seam traces the sweep
// line. Mid drives a slight wobble in the sweep; bass brightens the seam.

const float TWO_PI = 6.28318530718;

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    float aspect = iAspectX / iAspectY;
    float p = iProgressEased;

    // Aspect-corrected coords centered on a (usually) central pivot.
    vec2 center = vec2(0.5);
    // Occasionally offset the pivot for variety.
    if (mod(float(iRandStatic.w) * 0.01, 3.0) < 1.0)
    {
        center = vec2(
            mod(float(iRandStatic.x) * 0.001, 0.5) + 0.25,
            mod(float(iRandStatic.y) * 0.001, 0.5) + 0.25
        );
    }

    vec2 c = uv - center;
    c.x *= aspect;

    // Random start angle and sweep direction.
    float startAngle = mod(float(iRandStatic.x), 360.0) * (TWO_PI / 360.0);
    float dir = (mod(float(iRandStatic.z) * 0.01, 2.0) < 1.0) ? 1.0 : -1.0;

    // Angle of this pixel relative to the start, normalized to [0, 1) around the circle.
    float ang = atan(c.y, c.x) - startAngle;
    ang *= dir;
    float frac = fract(ang / TWO_PI);   // 0..1 around the sweep

    // Slight mid-driven wobble so the sweep breathes with the music.
    float midPump = clamp(iMidAtt, 0.0, 2.0);
    float wobble = 0.03 * midPump * sin(frac * TWO_PI * 3.0 + iTime * 2.0);
    float sweep = p + wobble;

    // Soft leading edge on the sweep hand.
    float edge = 0.04 + 0.03 * midPump;
    // reveal = 1 where the new preset has been swept in.
    float reveal = 1.0 - smoothstep(sweep - edge, sweep + edge, frac);

    vec3 oldImg = texture(iChannel0, uv).xyz;
    vec3 newImg = texture(iChannel1, uv).xyz;

    // Composite via the selected advanced blend mode (Phase B3 library reuse).
    vec3 col = prjmBlendPresets(oldImg, newImg, reveal);

    // Glowing seam traced along the sweep hand itself.
    float seam = smoothstep(edge, 0.0, abs(frac - sweep));
    // Fade the seam out near the very start/end so it doesn't linger at edges.
    seam *= smoothstep(0.0, 0.08, p) * smoothstep(1.0, 0.92, p);
    float bassPump = clamp(iBassAtt, 0.0, 2.0);
    col += vec3(0.5, 0.7, 1.0) * seam * (0.35 + 0.35 * bassPump);

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
