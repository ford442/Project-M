// Burn — a beloved Milkdrop-style "burn away" dissolve (Phase B5). The old preset
// erodes along a noise field like burning paper: a hot ember edge glows just ahead
// of the advancing burn line, then cools to reveal the new preset behind it.
// Bass pumps the ember brightness; treble flickers the flame color.

float _burn_hash(vec2 p)
{
    float seed = float(iRandStatic.x) * 0.001 + 0.271;
    return fract(sin(dot(p, vec2(41.31, 289.7)) + seed) * 43758.5453);
}

// Two-octave value noise so the burn front looks organic, not blocky.
float _burn_noise(vec2 uv, float scale)
{
    vec2 g = uv * scale;
    vec2 id = floor(g);
    vec2 f  = fract(g);
    f = f * f * (3.0 - 2.0 * f);
    float bl = _burn_hash(id + vec2(0.0, 0.0));
    float br = _burn_hash(id + vec2(1.0, 0.0));
    float tl = _burn_hash(id + vec2(0.0, 1.0));
    float tr = _burn_hash(id + vec2(1.0, 1.0));
    return mix(mix(bl, br, f.x), mix(tl, tr, f.x), f.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    float p = iProgressEased;

    // Randomize burn scale and a directional bias so some transitions burn from
    // an edge and others burn from scattered hot-spots.
    float scale = mod(float(iRandStatic.y) * 0.01, 6.0) + 5.0;   // 5..11
    float dirBias = mod(float(iRandStatic.z) * 0.001, 1.0);      // 0..1

    // Burn field: fractal noise plus a gentle directional gradient.
    float n = _burn_noise(uv, scale) * 0.65 + _burn_noise(uv, scale * 2.3) * 0.35;
    float gradient = mix(uv.x, uv.y, dirBias);
    float field = mix(n, gradient, 0.35);

    // The burn line sweeps 0 -> 1. Everything below the line has burned away.
    // A thin band around the line is the glowing ember edge.
    float bassPump = clamp(iBassAtt, 0.0, 2.0);
    float trebPump = clamp(iTrebAtt, 0.0, 2.0);
    float edgeWidth = 0.10 + 0.05 * bassPump;

    // burn = 1 where the old preset is gone (new preset shown), 0 where it remains.
    float burn = smoothstep(p - edgeWidth, p + edgeWidth, field);

    vec3 oldImg = texture(iChannel0, uv).xyz;
    vec3 newImg = texture(iChannel1, uv).xyz;

    // Composite via the selected advanced blend mode (Phase B3 library reuse).
    vec3 col = prjmBlendPresets(oldImg, newImg, burn);

    // Ember edge: brightest exactly on the burn line, biased to the still-burning
    // (not-yet-revealed) side so it reads as fire consuming the old image.
    float ember = smoothstep(p + edgeWidth, p, field) *
                  smoothstep(p - edgeWidth * 1.5, p, field);
    ember = clamp(ember, 0.0, 1.0);

    // Flame color cycles slightly with treble; core is white-hot, fringe deep red.
    float hue = fract(0.02 + trebPump * 0.06 + float(iRandStatic.w) * 0.0005);
    vec3 hot  = vec3(1.0, 0.85, 0.45);
    vec3 cool = vec3(0.9, 0.25, 0.05);
    vec3 flame = mix(cool, hot, ember);
    flame += vec3(0.3, 0.1, 0.0) * sin(6.28318 * hue);

    // A charred darkening just behind the ember before the new preset brightens in.
    float char = smoothstep(p + edgeWidth * 2.0, p + edgeWidth, field) *
                 (1.0 - burn) * 0.5;
    col *= 1.0 - char;

    col += flame * ember * (1.1 + 0.7 * bassPump);

    fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
