sampler sampler_pw_noise_lq;
float3 swirl(float2 p, float t) { return float3(sin(p.x * 6 + t), cos(p.y * 6 - t), 0.5); }
shader_body
{
    float4 noise = tex2D(sampler_noise_lq, uv * texsize_noise_lq.xy / 256);
    float3 vol = tex3D(sampler_noisevol_hq, float3(uv, time * 0.1)).xyz;
    float2 r = float2(cos(ang), sin(ang)) * rad;
    ret = lerp(tex2D(sampler_main, uv).xyz, swirl(r, time), saturate(q1));
    ret = ret * hue_shader + vol * 0.1 + noise.x * 0.05 + GetBlur3(uv);
    ret = pow(abs(ret), float3(1, 1, 1) * 1.2);
}
