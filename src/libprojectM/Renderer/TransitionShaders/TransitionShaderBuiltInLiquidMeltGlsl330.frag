// LiquidMelt — the classic Milkdrop "melt away" look (Phase B5). The old preset
// softens into vertical columns that sag and drip off the bottom of the screen at
// staggered speeds, stretching like hot wax and revealing the new preset behind
// the receding melt line. A wet meniscus highlight and a refractive lens along
// the drip front sell the liquid feel.
//
// Bass accelerates the drips; treble adds fine surface ripple on the melt line.

float _melt_hash(float x)
{
    float seed = float(iRandStatic.x & 4095) * 0.0013 + 0.517;
    return fract(sin(x * 37.719 + seed) * 21735.8371);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    float p = iProgressEased;

    float bassPump = clamp(iBassAtt, 0.0, 2.0);
    float trebPump = clamp(iTrebAtt, 0.0, 2.0);

    // Column count varies per transition: coarse slabs through fine strands.
    float columns = 24.0 + mod(float(iRandStatic.y & 255), 56.0); // 24..80
    float columnIndex = floor(uv.x * columns);
    float r1 = _melt_hash(columnIndex);
    float r2 = _melt_hash(columnIndex + 91.0);

    // Staggered start: each column hangs on a moment longer than its neighbours,
    // so the sheet breaks up instead of sliding as one block.
    float delay = r1 * 0.30;
    float local = clamp((p - delay) / max(1.0 - delay, 0.001), 0.0, 1.0);

    // Ease the fall so columns accelerate under gravity, and let bass shove them.
    float gravity = local * local * (0.85 + 0.30 * r2) * (1.0 + 0.20 * bassPump);
    float drop = clamp(gravity * 1.35, 0.0, 1.35);

    // Surface tension: a fine ripple travelling across the melt line, plus a slow
    // sway so the front is never a straight edge.
    float ripple = sin(uv.x * (18.0 + 12.0 * r2) + iTime * (1.5 + 2.0 * trebPump)) * 0.006;
    float sway = sin(uv.x * 3.1 + r1 * 6.283 + iTime * 0.7) * 0.010;
    float frontY = 1.0 - drop + ripple + sway;

    // Horizontal wobble of the sagging column — thicker drips wander more.
    float wobble = sin(uv.y * 9.0 + iTime * 1.3 + r2 * 6.283) * 0.004 * drop;

    // The old preset slides down by `drop`: what used to be above this pixel is
    // now here. Sampling at uv.y + drop stays inside [0, 1] because everything
    // above frontY is masked out below.
    vec2 oldUV = vec2(clamp(uv.x + wobble, 0.0, 1.0), clamp(uv.y + drop, 0.0, 1.0));

    // Band around the melt line where the "liquid" refracts what is behind it.
    float band = 0.045 + 0.02 * bassPump;
    float edge = 1.0 - smoothstep(0.0, band, abs(uv.y - frontY));

    // Lens: near the front the new preset is magnified slightly and pulled toward
    // the melt line, the way a fluid meniscus bends the image behind it.
    vec2 lens = vec2(0.0, (uv.y - frontY) * 0.35 * edge);
    vec2 newUV = clamp(uv + lens, 0.0, 1.0);

    vec3 oldImg = texture(iChannel0, oldUV).xyz;
    vec3 newImg = texture(iChannel1, newUV).xyz;

    // reveal = 1 above the melt line (old material has drained away).
    float reveal = smoothstep(frontY - band * 0.5, frontY + band * 0.5, uv.y);

    // Composite through the Phase B3 blend library so the melt inherits the
    // transition's randomized blend mode.
    vec3 col = prjmBlendPresets(oldImg, newImg, reveal);

    // Wet meniscus: a bright rim just below the line, darkening just above it,
    // which reads as a thick liquid lip catching the light.
    float lip = edge * smoothstep(frontY + band * 0.4, frontY - band * 0.2, uv.y);
    col += vec3(0.55, 0.62, 0.75) * lip * (0.28 + 0.22 * bassPump);
    col *= 1.0 - edge * smoothstep(frontY - band * 0.2, frontY + band * 0.6, uv.y) * 0.25;

    // Vertical smear streaks in the sagging body — stretched highlights that make
    // the falling material look like it is being pulled thin.
    float streak = _melt_hash(columnIndex + 311.0);
    col += vec3(0.10, 0.10, 0.12) * (1.0 - reveal) * drop * streak;

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
