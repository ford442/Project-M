layout(location = 0) in vec2 vertex_position;
layout(location = 2) in vec2 vertex_texture;

// _pm_blur (Renderer::BlurUniforms), the same block in every stage of both blur programs.
layout(std140) uniform _pm_blur {
    vec4 _c0; // source texsize (.xy), and inverse (.zw)
    vec4 _c1; // w1..w4
    vec4 _c2; // d1..d4
    vec4 _c3; // scale, bias, w_div
    vec4 _c5; // w1,w2,d1,d2
    vec4 _c6; // w_div, edge_darken_c1, edge_darken_c2, edge_darken_c3
    int flipVertical;
};

out vec2 fragment_texture;

void main(){
    gl_Position = vec4(vertex_position, 0.0, 1.0);
    fragment_texture = vertex_texture;

    // Vertically flip main texture, but not the already blurred ones.
    if (flipVertical == 1)
    {
        fragment_texture.y = 1.0 - fragment_texture.y;
    }
}
