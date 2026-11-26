shader_body
{
    float2 d = uv - 0.5;
    ret = tex2D(sampler_main, uv + d * 0.01).xyz * 0.98;
    ret += GetBlur1(uv) * 0.1;
}
