// StarWipe — the classic "star wipe" (Phase B5). A star opens from a point near the
// middle of the screen and grows until it covers everything, revealing the new
// preset inside it while it slowly turns. The star has 4 to 7 points (usually 5);
// bass pulls its valleys in so the points stab outwards on the beat, and a glowing
// rim, brightened by bass and glittered by treble, traces its edge.
//
// The star is a mask, not a moving boundary: every pixel gets its "star distance"
// m in [0, 1] (0 at the centre, 1 for the screen corner furthest along a valley),
// and the reveal is the same remapped smoothstep threshold as blendMasked() uses,
// so p == 0 is exactly the old preset and p == 1 exactly the new one for any star
// shape — including one bass has just pinched. The composite goes through
// prjmBlendPresets(), so the random blend mode applies to the reveal.

const float STAR_PI = 3.14159265359;

// Radius of a unit star polygon along `theta`: 1 at the points, `inner` in the
// valleys, and straight edges between them.
float _starRadius(float theta, float points, float inner)
{
    float sector = STAR_PI / points;                        // point-to-valley angle
    float a = sector - abs(mod(theta, 2.0 * sector) - sector); // angle from the nearest point, 0..sector
    vec2 edge = vec2(inner * cos(sector) - 1.0, inner * sin(sector)); // point (1,0) -> valley
    return edge.y / (cos(a) * edge.y - sin(a) * edge.x);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    float p = clamp(iProgressEased, 0.0, 1.0);
    float aspect = iResolution.x / max(iResolution.y, 1.0);

    // Shape: usually five points, sometimes 4, 6 or 7.
    int pick = iRandStatic.y & 7; // 0..3: 5 points, 4..7: that many
    float points = pick < 4 ? 5.0 : float(pick);
    float baseInner = 0.38 + 0.17 * fract(float(iRandStatic.z & 1023) * 0.00377);

    // Bass pulls the valleys in, mostly mid-transition.
    float hump = 4.0 * p * (1.0 - p);
    float bassPump = clamp(iBassAtt, 0.0, 2.0);
    float inner = baseInner * (1.0 - 0.18 * bassPump * hump);

    // Centre near the middle; the star turns a little as it grows.
    vec2 center = vec2(0.35 + 0.3 * fract(float(iRandStatic.w & 1023) * 0.00611),
                       0.35 + 0.3 * fract(float(iRandStatic.x & 1023) * 0.00433));
    float spinDir = (iRandStatic.z & 256) != 0 ? 1.0 : -1.0;
    float rotation = float(iRandStatic.x & 1023) * 0.0061 + spinDir * p * 0.9;

    vec2 c = (uv - center) * vec2(aspect, 1.0);
    float theta = atan(c.y, c.x) - rotation;

    // Scale the star so that, valleys included, it has covered the furthest corner by m == 1.
    vec2 farCorner = max(center, 1.0 - center) * vec2(aspect, 1.0);
    float fullRadius = length(farCorner) / inner;
    float dist = length(c);
    // atan(0, 0) is undefined in GLSL, so the exact centre is set, not computed.
    // The square root paces the wipe: the star's size goes with p squared, so it starts
    // small and does not swallow the frame by mid-transition (the star has to overshoot
    // the screen a lot before its valleys reach the corners).
    float m = dist > 1.0e-6 ? sqrt(clamp(dist / (fullRadius * _starRadius(theta, points, inner)), 0.0, 1.0)) : 0.0;

    // Same exact-endpoint threshold as blendMasked().
    const float softness = 0.012;
    float threshold = p * (1.0 + 2.0 * softness) - softness;
    float reveal = smoothstep(m - softness, m + softness, threshold);

    vec3 oldImg = texture(iChannel0, uv).xyz;
    vec3 newImg = texture(iChannel1, uv).xyz;
    vec3 col = prjmBlendPresets(oldImg, newImg, reveal);

    // Rim light along the edge, faded in and out with the transition.
    float rim = 1.0 - smoothstep(0.0, 0.03, abs(m - threshold));
    float hue = iTime * 0.6 + float(iRandStatic.y & 255) * 0.05;
    vec3 rimColor = 0.6 + 0.4 * cos(vec3(0.0, 2.1, 4.2) + hue);
    float trebPump = clamp(iTrebAtt, 0.0, 2.0);
    float glitter = fract(sin(dot(floor(fragCoord / 2.0), vec2(12.9898, 78.233)) + floor(iTime * 15.0)) * 43758.5453);
    float rimLight = rim * hump * (0.45 + 0.35 * bassPump) + rim * hump * step(0.93, glitter) * trebPump * 0.5;
    col += rimColor * rimLight;

    fragColor = vec4(col, 1.0);
}
