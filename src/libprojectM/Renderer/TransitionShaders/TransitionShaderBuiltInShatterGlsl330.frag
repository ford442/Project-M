// Shatter — the "glass break" transition (Phase B5). The old preset is a pane of
// glass: cracks race out from an impact point, then the pane breaks into Voronoi
// shards that let go one after another — nearest the impact first — and fall away
// into the distance, each one dropping, spinning and shrinking on its own schedule,
// to reveal the new preset behind it. Bass flares the light caught on the shard
// edges; treble makes the edges glitter.
//
// A pixel shows shard c if undoing c's motion (translate, rotate, scale about its
// seed) lands it inside c's original Voronoi cell, i.e. on the near side of the
// bisector to each of c's eight neighbouring seeds. Shards recede by shrinking
// rather than by flying off-screen, so none ever covers a pixel more than about one
// cell from where it started: the candidates are the 3x3 cells around the pixel,
// their neighbours the surrounding 5x5, and those 25 seeds are computed once. Where
// shards overlap, the one that has moved least is in front (the others are further
// away). Seeds are kept 0.15 cells off their cell walls, which is what keeps every
// Voronoi neighbour of a seed inside its own 3x3 block.
//
// The endpoints are exact. At p == 0 no shard has let go (the earliest starts at
// 0.12), the pixel is tested at rest against its own seeds and sampled at its own uv,
// and the crack light has not started, so the frame is the old preset. At p == 1
// every shard has scaled to nothing, so the frame is the new preset.

const float SHATTER_JITTER = 0.7; // seed offset range inside its cell: 0.15..0.85

vec2 _shatterHash2(vec2 cell)
{
    float s = float(iRandStatic.x & 4095) * 0.0137;
    vec2 q = vec2(dot(cell, vec2(127.1, 311.7)), dot(cell, vec2(269.5, 183.3)));
    return fract(sin(q + s) * 43758.5453);
}

float _shatterHash1(vec2 cell)
{
    float s = float(iRandStatic.y & 4095) * 0.0213;
    return fract(sin(dot(cell, vec2(41.37, 289.11)) + s) * 23421.631);
}

vec2 _shatterSeed(vec2 cell)
{
    return cell + 0.5 * (1.0 - SHATTER_JITTER) + SHATTER_JITTER * _shatterHash2(cell);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = fragCoord / iResolution.xy;
    float p = clamp(iProgressEased, 0.0, 1.0);
    float aspect = iResolution.x / max(iResolution.y, 1.0);

    // Shard grid: 5..8 cells down the screen, square cells across.
    float cellsY = 5.0 + mod(float(iRandStatic.z & 255), 4.0);
    vec2 gridScale = vec2(cellsY * aspect, cellsY);
    vec2 P = uv * gridScale;

    // Impact point, somewhere in the middle half of the screen.
    vec2 impactUv = vec2(0.25 + 0.5 * fract(float(iRandStatic.w & 1023) * 0.00731),
                         0.25 + 0.5 * fract(float(iRandStatic.x & 1023) * 0.00517));
    vec2 impact = impactUv * gridScale;
    float maxDist = length(gridScale);

    vec2 base = floor(P);
    vec2 seeds[25];
    for (int j = 0; j < 5; j++)
    {
        for (int i = 0; i < 5; i++)
        {
            seeds[j * 5 + i] = _shatterSeed(base + vec2(float(i - 2), float(j - 2)));
        }
    }

    float bassPump = clamp(iBassAtt, 0.0, 2.0);
    float trebPump = clamp(iTrebAtt, 0.0, 2.0);

    bool covered = false;
    float frontLp = 2.0;     // motion progress of the shard in front
    vec2 frontUv = uv;       // where that shard samples the old preset
    float frontEdge = 0.0;   // 1 on that shard's edges
    float frontCrack = 0.0;  // how far its cracks have lit up
    float frontSpin = 0.0;

    for (int cj = -1; cj <= 1; cj++)
    {
        for (int ci = -1; ci <= 1; ci++)
        {
            vec2 cell = base + vec2(float(ci), float(cj));
            vec2 seed = seeds[(cj + 2) * 5 + (ci + 2)];

            // When this shard lets go: near the impact first, with some scatter.
            float rnd = _shatterHash1(cell);
            float d = clamp(length(seed - impact) / maxDist, 0.0, 1.0);
            float start = 0.12 + 0.38 * d + 0.12 * rnd; // 0.12..0.62
            float lp = clamp((p - start) / (1.0 - start), 0.0, 1.0);

            float scale = 1.0 - smoothstep(0.0, 1.0, lp);
            if (scale < 0.002)
            {
                continue; // fallen out of sight
            }

            // Undo the shard's motion. A shard at rest is tested at the pixel itself,
            // not at a rounded round trip, so p == 0 tiles the pane exactly.
            vec2 q = P;
            float spin = 0.0;
            if (lp > 0.0)
            {
                float fall = lp * lp;
                vec2 away = seed - impact;
                float awayLen = length(away);
                vec2 dir = awayLen > 0.001 ? away / awayLen : vec2(0.0, 1.0);
                // Down is -y in fragment coordinates.
                vec2 offset = (dir * 0.45 + vec2(0.0, -0.55) + (_shatterHash2(cell + 17.0) - 0.5) * 0.4) * fall;
                spin = (rnd - 0.5) * 2.4 * fall;

                vec2 rel = (P - (seed + offset)) / scale;
                float cs = cos(spin);
                float sn = sin(spin);
                q = seed + vec2(cs * rel.x + sn * rel.y, -sn * rel.x + cs * rel.y);
            }

            // Signed distance to the cell's walls, positive inside.
            float inside = 1.0e3;
            for (int dj = -1; dj <= 1; dj++)
            {
                for (int di = -1; di <= 1; di++)
                {
                    if (di == 0 && dj == 0)
                    {
                        continue;
                    }
                    vec2 other = seeds[(cj + dj + 2) * 5 + (ci + di + 2)];
                    vec2 axis = normalize(other - seed);
                    inside = min(inside, dot(0.5 * (seed + other) - q, axis));
                }
            }

            if (inside >= 0.0 && lp < frontLp)
            {
                covered = true;
                frontLp = lp;
                frontUv = lp > 0.0 ? q / gridScale : uv;
                // Edge width in screen cells, whatever the shard's current size.
                frontEdge = 1.0 - smoothstep(0.0, 0.045, inside * scale);
                // Cracks light up in the 0.12 before the shard lets go.
                frontCrack = smoothstep(start - 0.12, start, p);
                frontSpin = spin;
            }
        }
    }

    vec3 newImg = texture(iChannel1, uv).xyz;
    if (!covered)
    {
        fragColor = vec4(newImg, 1.0);
        return;
    }

    vec3 col = texture(iChannel0, clamp(frontUv, 0.0, 1.0)).xyz;

    // A falling shard dims as it recedes and flashes when its tilt catches the light.
    float flash = pow(max(sin(frontSpin * 3.0 + 1.3), 0.0), 8.0) * frontLp * (1.0 - frontLp) * 4.0;
    col = col * (1.0 - 0.45 * frontLp) + vec3(0.9, 0.95, 1.0) * flash * 0.35;

    // Light along the cracks and shard edges, brightest while the pane is still whole.
    float light = frontEdge * frontCrack * (1.0 - 0.4 * frontLp);
    col += vec3(0.85, 0.92, 1.0) * light * (0.3 + 0.35 * bassPump);

    // Treble glitter: sparse sparks along the lit edges, reshuffled ~12 times a second.
    vec2 sparkCell = floor(fragCoord / 3.0);
    float spark = fract(sin(dot(sparkCell, vec2(12.9898, 78.233)) + floor(iTime * 12.0) * 7.31) * 43758.5453);
    col += vec3(1.0) * step(0.96, spark) * light * trebPump * 0.6;

    // Not clamped: at rest this is the old preset's own value, HDR included.
    fragColor = vec4(col, 1.0);
}
