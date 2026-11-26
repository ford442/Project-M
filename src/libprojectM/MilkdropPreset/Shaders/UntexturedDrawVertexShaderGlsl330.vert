layout(location = 0) in vec2 vertex_position;
layout(location = 1) in vec4 vertex_color;

// _pm_transform (Renderer::TransformUniforms, docs/RENDER_DEVICE.md "Uniform buffers").
layout(std140) uniform _pm_transform {
    mat4 vertex_transformation;
    float vertex_point_size;
};

out vec4 fragment_color;

void main(){
    gl_Position = vertex_transformation * vec4(vertex_position, 0.0, 1.0);
    gl_PointSize = vertex_point_size;
    fragment_color = vertex_color;
}
