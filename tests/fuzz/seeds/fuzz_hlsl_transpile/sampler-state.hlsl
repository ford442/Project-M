sampler2D sampler_fw_main = sampler_state { Filter = LINEAR; AddressU = WRAP; };
// shader_body in a comment must not be matched
shader_body
{
    /* { braces in a block comment } */
    ret = tex2D(sampler_fw_main, uv).xyz;
    ret.x = fmod(ret.x + 0.01, 1.0);
}
trailing text after the closing brace
