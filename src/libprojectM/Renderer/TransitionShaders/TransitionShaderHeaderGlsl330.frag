// Uniforms
uniform vec3 iResolution;
uniform vec4 durationParams;
uniform vec2 timeParams;
uniform float iFrameRate;
uniform int iFrame;
uniform ivec4 iRandStatic;
uniform ivec4 iRandFrame;
uniform vec3 iBeatValues;
uniform vec3 iBeatAttValues;

// Aspect ratio correction uniforms for geometry-sensitive transitions.
uniform float iAspectX;
uniform float iAspectY;
uniform float iInvAspectX;
uniform float iInvAspectY;

// Milkdrop-style easing function for transition progress.
// easingType: 0 = linear, 1 = smoothstep (default), 2 = ease-in, 3 = ease-out
float _prjm_getEasedProgress(float t, float easingType)
{
    t = clamp(t, 0.0, 1.0);
    if (easingType < 0.5)
    {
        return t; // 0 = Linear
    }
    else if (easingType < 1.5)
    {
        return t * t * (3.0 - 2.0 * t); // 1 = Smoothstep (default)
    }
    else if (easingType < 2.5)
    {
        return t * t; // 2 = Ease-in (quadratic)
    }
    else
    {
        return 1.0 - (1.0 - t) * (1.0 - t); // 3 = Ease-out (quadratic)
    }
}

#define iProgressLinear durationParams.x
#define iProgressCosine durationParams.y
#define iProgressBicubic durationParams.z
#define iEasingType durationParams.w
#define iProgressEased _prjm_getEasedProgress(durationParams.x, durationParams.w)

#define iTime timeParams.x
#define iTimeDelta timeParams.y

#define iBass iBeatValues.x
#define iMid iBeatValues.y
#define iTreb iBeatValues.z

#define iBassAtt iBeatAttValues.x
#define iMidAtt iBeatAttValues.y
#define iTrebAtt iBeatAttValues.z

// Multi-pass uniforms
uniform int iPass;              //!< Current render pass (0 = first, 1 = second).
uniform sampler2D iLastPassTex; //!< Result of the previous pass (valid in pass 1+).

// Transparency mode for glass-layer compositing over host page content.
uniform int u_transparencyEnabled;
uniform float u_transparencyThreshold;

// === Advanced Blending Library (Phase B3) ===
uniform int iBlendMode; // 0=Alpha, 1=Additive, 2=Multiplicative, 3=Screen, 4=Masked

vec4 blendAlpha(vec4 a, vec4 b, float t)
{
    return mix(a, b, t);
}

// Endpoint contract shared by every stylized blend mode: t == 0 must be exactly
// `a` and t == 1 exactly `b`. Left to themselves, Additive ends on (old + new),
// Multiplicative on (old * new) and Screen on screen(old, new) — none of which is
// the new preset, so the frame the transition completes and the renderer hard-cuts
// to it visibly pops. Weighting the stylized composite with a hump that vanishes
// at both ends removes the pop while leaving the mid-transition look — where the
// mode's character actually reads — untouched.
//
// Note that many transitions pass a per-pixel mask as `t` rather than progress; for
// those this keeps fully-old and fully-new regions clean and confines the stylized
// blend to the moving band, which is what those effects want anyway.
vec4 _prjmEndpointSafe(vec4 a, vec4 b, float t, vec4 stylized)
{
    float clamped = clamp(t, 0.0, 1.0);
    float hump = 4.0 * clamped * (1.0 - clamped);
    return mix(mix(a, b, clamped), stylized, hump);
}

vec4 blendAdditive(vec4 a, vec4 b, float t)
{
    return _prjmEndpointSafe(a, b, t, a + b * t);
}

vec4 blendMultiplicative(vec4 a, vec4 b, float t)
{
    return _prjmEndpointSafe(a, b, t, a * (1.0 - t) + (a * b) * t);
}

vec4 blendScreen(vec4 a, vec4 b, float t)
{
    vec4 screen = 1.0 - (1.0 - a) * (1.0 - b);
    return _prjmEndpointSafe(a, b, t, mix(a, screen, t));
}

// --- Masked blend (procedural dissolve mask) ---
//
// The mask is generated in-shader rather than sampled from a texture: the noise
// samplers are optional (they can be absent when the texture manager has no
// noise textures loaded) and an unbound sampler would silently collapse the mask
// to black. A two-octave value noise keyed off iRandStatic keeps the pattern
// stable for the whole transition but different from one transition to the next.
float _prjm_maskHash(vec2 p)
{
    float seed = float(iRandStatic.x & 1023) * 0.017 + 0.113;
    return fract(sin(dot(p, vec2(27.13, 61.79)) + seed) * 24634.6345);
}

float _prjm_maskNoise(vec2 uv)
{
    // Cell size varies per transition so some dissolves are coarse and blotchy,
    // others fine and grainy.
    float scale = 6.0 + mod(float(iRandStatic.y & 255), 12.0); // 6..18
    vec2 g = uv * scale;
    vec2 id = floor(g);
    vec2 f = fract(g);
    f = f * f * (3.0 - 2.0 * f);
    float bl = _prjm_maskHash(id);
    float br = _prjm_maskHash(id + vec2(1.0, 0.0));
    float tl = _prjm_maskHash(id + vec2(0.0, 1.0));
    float tr = _prjm_maskHash(id + vec2(1.0, 1.0));
    float base = mix(mix(bl, br, f.x), mix(tl, tr, f.x), f.y);

    vec2 g2 = uv * scale * 2.7;
    vec2 id2 = floor(g2);
    vec2 f2 = fract(g2);
    f2 = f2 * f2 * (3.0 - 2.0 * f2);
    float bl2 = _prjm_maskHash(id2 + vec2(19.0, 7.0));
    float br2 = _prjm_maskHash(id2 + vec2(20.0, 7.0));
    float tl2 = _prjm_maskHash(id2 + vec2(19.0, 8.0));
    float tr2 = _prjm_maskHash(id2 + vec2(20.0, 8.0));
    float detail = mix(mix(bl2, br2, f2.x), mix(tl2, tr2, f2.x), f2.y);

    return clamp(base * 0.7 + detail * 0.3, 0.0, 1.0);
}

// Turns a uniform blend factor into a per-pixel dissolve threshold. The factor is
// remapped so t == 0 leaves `a` untouched and t == 1 fully reveals `b` for every
// mask value — the transition still starts and ends exactly on time.
vec4 blendMasked(vec4 a, vec4 b, float t)
{
    const float softness = 0.18;
    float mask = _prjm_maskNoise(gl_FragCoord.xy / iResolution.xy);
    float threshold = clamp(t, 0.0, 1.0) * (1.0 + 2.0 * softness) - softness;
    float reveal = smoothstep(mask - softness, mask + softness, threshold);
    return mix(a, b, reveal);
}

// Convenience helper for transitions that sample old/new colors separately.
vec3 prjmBlendPresets(vec3 oldCol, vec3 newCol, float t)
{
    vec4 a = vec4(oldCol, 1.0);
    vec4 b = vec4(newCol, 1.0);
    vec4 result;
    if (iBlendMode == 1)
        result = blendAdditive(a, b, t);
    else if (iBlendMode == 2)
        result = blendMultiplicative(a, b, t);
    else if (iBlendMode == 3)
        result = blendScreen(a, b, t);
    else if (iBlendMode == 4)
        result = blendMasked(a, b, t);
    else
        result = blendAlpha(a, b, t);
    return result.xyz;
}

// Samplers
uniform sampler2D iChannel0;
uniform sampler2D iChannel1;

// These are named as in Milkdrop shaders so we can reuse the code.
uniform sampler2D sampler_noise_lq;
uniform sampler2D sampler_pw_noise_lq;
uniform sampler2D sampler_noise_mq;
uniform sampler2D sampler_pw_noise_mq;
uniform sampler2D sampler_noise_hq;
uniform sampler2D sampler_pw_noise_hq;
uniform sampler3D sampler_noisevol_lq;
uniform sampler3D sampler_pw_noisevol_lq;
uniform sampler3D sampler_noisevol_hq;
uniform sampler3D sampler_pw_noisevol_hq;

#define iNoiseLQ sampler_noise_lq
#define iNoiseLQNearest sampler_pw_noise_lq
#define iNoiseMQ sampler_noise_mq
#define iNoiseMQNearest sampler_pw_noise_mq
#define iNoiseHQ sampler_noise_hq
#define iNoiseHQNearest sampler_pw_noise_hq
#define iNoiseVolLQ sampler_noisevol_lq
#define iNoiseVolLQNearest sampler_pw_noisevol_lq
#define iNoiseVolHQ sampler_noisevol_hq
#define iNoiseVolHQNearest sampler_pw_noisevol_hq

// Shader output
out vec4 _prjm_transition_out;
