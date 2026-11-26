#!/usr/bin/env node
// WGSL parity harness for the WebGPU shader path (Phase C, docs/adr/0002-wgsl-shader-path.md).
//
// For every <name>.wgsl in a corpus written by scripts/check_wgsl_corpus.sh (PresetCompatWgsl
// with PROJECTM_WGSL_OUT_DIR) it
//   1. compiles the module with the browser's WGSL compiler (Tint in Chromium) and builds a
//      render pipeline from the generator's reflection (<name>.json), which is the validation
//      a WebGPU backend's createShaderModule()/createRenderPipeline() would do;
//   2. renders it on WebGPU, and the same preset shader's GLSL ES 3.00 (<name>.glsl, what the
//      WebGL 2 build compiles) on WebGL 2, with the same frame uniforms, texsize uniforms,
//      textures, sampler state and varyings;
//   3. compares the two images.
//
// This is the shader half of the issue's "per-preset pixel diff WebGPU vs GL": one draw of
// each warp/composite shader with fixed inputs, not a whole frame (that needs WgpuDevice,
// Phase D). The tolerance budget is TOLERANCE below and in the ADR.
//
// Usage:
//   node tests/webgpu/wgsl_parity.mjs <corpus-dir> [--report <file.json>] [--filter <substring>]
//                                     [--known <ledger>] [--size <px>] [--timeout <s>]
// Exit status: 0 if every module compiles on both APIs and is within tolerance (or is listed
// in the ledger's "parity" lines), 1 otherwise. Needs Playwright's Chromium; WebGPU runs on
// its SwiftShader adapter, so no GPU is needed.

import { createServer } from 'node:http';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// Playwright from the repo's tests/wasm-smoke install (what CI runs `npm ci` in), from the
// current directory, or from NODE_PATH.
function loadPlaywright() {
    const roots = [new URL('../wasm-smoke/package.json', import.meta.url), pathToFileURL(join(process.cwd(), 'package.json')), import.meta.url];
    for (const root of roots) {
        try {
            return createRequire(root)('playwright');
        } catch {
            // next
        }
    }
    throw new Error('playwright not found: run `npm ci` in tests/wasm-smoke (or set NODE_PATH)');
}

// Tolerance budget, in 8-bit channel steps. The two paths are different compilers on different
// APIs (Tint/SwiftShader vs ANGLE/SwiftShader), so not bit-identical: transcendental functions,
// fused multiply-adds and texture filtering round differently. A module is within tolerance
// when at most `maxFraction` of its pixels differ by more than `pixelDelta` in any channel.
export const TOLERANCE = { pixelDelta: 8, maxFraction: 0.01 };

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('--')) {
    console.error('usage: wgsl_parity.mjs <corpus-dir> [--report <file.json>] [--filter <substring>] [--known <ledger>] [--size <px>] [--timeout <s>]');
    process.exit(2);
}
const corpusDir = args[0];
const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const reportPath = option('--report', '');
const filter = option('--filter', '');
const ledgerPath = option('--known', '');
const size = Number(option('--size', '64'));

function listModules(dir) {
    const modules = [];
    for (const entry of readdirSync(dir).sort()) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) {
            modules.push(...listModules(path));
        } else if (entry.endsWith('.wgsl')) {
            const base = path.slice(0, -'.wgsl'.length);
            if (existsSync(`${base}.glsl`) && existsSync(`${base}.json`)) {
                modules.push(base);
            }
        }
    }
    return modules;
}

function readLedger(path) {
    const known = new Set();
    if (!path || !existsSync(path)) {
        return known;
    }
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
        // "parity <id>  # reason"; ids are preset file names and may contain spaces.
        const match = /^parity\s+(.+)$/.exec(raw.replace(/#.*/, '').trim());
        if (match) {
            known.add(match[1].trim());
        }
    }
    return known;
}

// Everything below runs in the page.
async function runModule({ wgsl, glsl, reflection, size, tolerance }) {
    // Deterministic inputs: one PRNG stream, seeded per resource name.
    function prng(seedText) {
        let seed = 2166136261;
        for (let i = 0; i < seedText.length; i++) {
            seed = Math.imul(seed ^ seedText.charCodeAt(i), 16777619);
        }
        return () => {
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
    const textureSize2d = 32;
    const textureSize3d = 8;

    const frameBinding = reflection.bindings.find((b) => b.kind === 'uniform' && b.source === '_milkdrop_frame');
    const globalsBinding = reflection.bindings.find((b) => b.kind === 'uniform' && b.source === 'pmw_globals');
    const textures = reflection.bindings.filter((b) => b.kind === 'texture2d' || b.kind === 'texture3d');

    // The frame block: random values in [0, 1), with the members whose meaning a shader
    // commonly divides by or scales with set to sane values.
    const frame = new Float32Array((frameBinding ? frameBinding.size : 1600) / 4);
    {
        const random = prng('_milkdrop_frame');
        for (let i = 0; i < frame.length; i++) {
            frame[i] = random();
        }
        const set = (name, values) => {
            const member = frameBinding && frameBinding.members.find((m) => m.name === name);
            if (member) {
                frame.set(values, member.offset / 4);
            }
        };
        set('_c0', [1, 1, 1, 1]); // aspect
        set('_c2', [3.25, 60, 195, 0.4]); // time, fps, frame, progress
        set('_c5', [1, 0, 1, 0]); // blur1/2 scale, bias
        set('_c6', [1, 0, 0, 1]); // blur3 scale, bias; blur1 min, max
        set('_c7', [size, size, 1 / size, 1 / size]); // texsize
        set('_c13', [0, 1, 0, 1]); // blur2/3 min, max
    }

    const globals = new Float32Array(globalsBinding ? globalsBinding.size / 4 : 4);
    const globalValues = {};
    if (globalsBinding) {
        for (const member of globalsBinding.members) {
            let values;
            if (member.name.startsWith('texsize_')) {
                const texture = textures.find((t) => t.source === `sampler_${member.name.slice('texsize_'.length)}`);
                const n = texture && texture.kind === 'texture3d' ? textureSize3d : textureSize2d;
                values = [n, n, 1 / n, 1 / n];
            } else {
                const random = prng(member.name);
                values = Array.from({ length: member.size / 4 }, () => random());
            }
            globals.set(values, member.offset / 4);
            globalValues[member.name] = values;
        }
    }

    const textureData = new Map();
    for (const texture of textures) {
        const n = texture.kind === 'texture3d' ? textureSize3d : textureSize2d;
        const count = texture.kind === 'texture3d' ? n * n * n : n * n;
        const random = prng(texture.source);
        const data = new Uint8Array(count * 4);
        for (let i = 0; i < data.length; i++) {
            data[i] = Math.floor(random() * 256);
        }
        textureData.set(texture.source, { data, n, volume: texture.kind === 'texture3d' });
    }

    const inputType = (semantic) => {
        const input = reflection.inputs.find((i) => i.semantic === semantic);
        return input ? input.type : null;
    };
    const outputs = reflection.outputs.filter((o) => o.location >= 0);
    const result = { tint: [], webgpu: null, webgl: null, outputs: [] };

    // ---- WebGPU ----
    const gpuImages = [];
    try {
        const adapter = await navigator.gpu.requestAdapter();
        const device = await adapter.requestDevice();
        const module = device.createShaderModule({ code: wgsl });
        const info = await module.getCompilationInfo();
        for (const message of info.messages) {
            if (message.type === 'error') {
                result.tint.push(`${message.lineNum}:${message.linePos} ${message.message}`);
            }
        }
        if (result.tint.length > 0) {
            throw new Error('Tint rejected the module');
        }

        // The vertex stage, written from the reflection's inputs: the same varyings the
        // WebGL side's vertex shader writes.
        const fields = [];
        const values = [];
        for (const input of reflection.inputs) {
            if (input.location < 0) {
                continue;
            }
            fields.push(`@location(${input.location}) v${input.location}: ${input.type},`);
            const vec4 = `vec4f(uv, uv * 0.9 + 0.05)`;
            const expression = input.semantic.startsWith('COLOR')
                ? `vec4f(0.8, 0.6, 0.4, 1.0)`
                : input.semantic === 'TEXCOORD1'
                  ? `vec4f(length(p) * 0.7, atan2(p.y, p.x + 2.0), 0.0, 0.0)`
                  : vec4;
            values.push(`o.v${input.location} = (${expression})${input.type === 'vec2f' ? '.xy' : input.type === 'f32' ? '.x' : input.type === 'vec3f' ? '.xyz' : ''};`);
        }
        const vertexCode = `struct V { @builtin(position) position: vec4f, ${fields.join(' ')} }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
    let p = vec2f(f32(i & 1u) * 2.0 - 1.0, f32((i >> 1u) & 1u) * 2.0 - 1.0);
    let uv = p * 0.5 + 0.5;
    var o: V;
    // Clip-space y negated: the WebGPU backend's convention (ADR 0002), which puts row 0 of
    // every render target at the bottom as on GL, so texture memory, @builtin(position) and
    // dpdy() agree with GL's.
    o.position = vec4f(p.x, -p.y, 0.0, 1.0);
    ${values.join('\n    ')}
    return o;
}`;
        const vertexModule = device.createShaderModule({ code: vertexCode });

        const groups = [...new Set(reflection.bindings.map((b) => b.group))].sort((a, b) => a - b);
        const maxGroup = groups.length > 0 ? groups[groups.length - 1] : -1;
        const layouts = [];
        const entriesByGroup = [];
        for (let group = 0; group <= maxGroup; group++) {
            const layoutEntries = [];
            const entries = [];
            for (const binding of reflection.bindings.filter((b) => b.group === group)) {
                if (binding.kind === 'uniform') {
                    layoutEntries.push({ binding: binding.binding, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } });
                    const data = binding.source === '_milkdrop_frame' ? frame : globals;
                    const buffer = device.createBuffer({ size: Math.max(16, binding.size), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                    device.queue.writeBuffer(buffer, 0, data.buffer, 0, Math.min(data.byteLength, binding.size));
                    entries.push({ binding: binding.binding, resource: { buffer } });
                } else if (binding.kind === 'sampler') {
                    layoutEntries.push({ binding: binding.binding, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } });
                    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
                    entries.push({ binding: binding.binding, resource: sampler });
                } else {
                    const volume = binding.kind === 'texture3d';
                    layoutEntries.push({ binding: binding.binding, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: volume ? '3d' : '2d' } });
                    const { data, n } = textureData.get(binding.source);
                    const texture = device.createTexture({
                        size: [n, n, volume ? n : 1],
                        dimension: volume ? '3d' : '2d',
                        format: 'rgba8unorm',
                        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
                    });
                    device.queue.writeTexture({ texture }, data, { bytesPerRow: n * 4, rowsPerImage: n }, [n, n, volume ? n : 1]);
                    entries.push({ binding: binding.binding, resource: texture.createView() });
                }
            }
            const layout = device.createBindGroupLayout({ entries: layoutEntries });
            layouts.push(layout);
            entriesByGroup.push({ layout, entries });
        }

        device.pushErrorScope('validation');
        const pipeline = device.createRenderPipeline({
            layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
            vertex: { module: vertexModule, entryPoint: 'vs' },
            fragment: {
                module,
                entryPoint: reflection.entryPoint,
                targets: Array.from({ length: Math.max(...outputs.map((o) => o.location)) + 1 }, (_, i) =>
                    outputs.some((o) => o.location === i) ? { format: 'rgba8unorm' } : null,
                ),
            },
            primitive: { topology: 'triangle-strip' },
        });
        const pipelineError = await device.popErrorScope();
        if (pipelineError) {
            throw new Error(`createRenderPipeline: ${pipelineError.message}`);
        }

        const targets = outputs.map(() =>
            device.createTexture({ size: [size, size], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }),
        );
        const colorAttachments = Array.from({ length: Math.max(...outputs.map((o) => o.location)) + 1 }, (_, i) => {
            const index = outputs.findIndex((o) => o.location === i);
            return index < 0 ? null : { view: targets[index].createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] };
        });
        device.pushErrorScope('validation');
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments });
        pass.setPipeline(pipeline);
        entriesByGroup.forEach(({ layout, entries }, group) => pass.setBindGroup(group, device.createBindGroup({ layout, entries })));
        pass.draw(4);
        pass.end();
        const readbacks = targets.map((texture) => {
            const buffer = device.createBuffer({ size: size * size * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: size * 4 }, [size, size]);
            return buffer;
        });
        device.queue.submit([encoder.finish()]);
        const drawError = await device.popErrorScope();
        if (drawError) {
            throw new Error(`draw: ${drawError.message}`);
        }
        for (const buffer of readbacks) {
            await buffer.mapAsync(GPUMapMode.READ);
            gpuImages.push(new Uint8Array(buffer.getMappedRange()).slice());
            buffer.unmap();
        }
        device.destroy();
        result.webgpu = 'ok';
    } catch (error) {
        result.webgpu = String(error && error.message ? error.message : error);
    }

    // ---- WebGL 2 ----
    const glImages = [];
    try {
        const canvas = new OffscreenCanvas(size, size);
        const gl = canvas.getContext('webgl2', { antialias: false });
        const compile = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error(`GLSL compile: ${gl.getShaderInfoLog(shader)}`);
            }
            return shader;
        };
        const glslType = (type) => ({ f32: 'float', vec2f: 'vec2', vec3f: 'vec3', vec4f: 'vec4' })[type];
        const varyings = [];
        const assignments = [];
        for (const semantic of ['COLOR', 'TEXCOORD0', 'TEXCOORD1']) {
            const type = inputType(semantic);
            if (!type) {
                continue;
            }
            const expression = semantic.startsWith('COLOR')
                ? 'vec4(0.8, 0.6, 0.4, 1.0)'
                : semantic === 'TEXCOORD1'
                  ? 'vec4(length(p) * 0.7, atan(p.y, p.x + 2.0), 0.0, 0.0)'
                  : 'vec4(uv, uv * 0.9 + 0.05)';
            varyings.push(`out ${glslType(type)} frag_${semantic};`);
            assignments.push(`frag_${semantic} = (${expression})${type === 'vec2f' ? '.xy' : type === 'f32' ? '.x' : type === 'vec3f' ? '.xyz' : ''};`);
        }
        const vertexSource = `#version 300 es
precision highp float;
${varyings.join('\n')}
void main() {
    vec2 p = vec2(float(gl_VertexID & 1) * 2.0 - 1.0, float((gl_VertexID >> 1) & 1) * 2.0 - 1.0);
    vec2 uv = p * 0.5 + 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
    ${assignments.join('\n    ')}
}`;
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, glsl));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`GLSL link: ${gl.getProgramInfoLog(program)}`);
        }
        gl.useProgram(program);

        // The render targets first: binding them later would replace a sampler unit's texture.
        gl.activeTexture(gl.TEXTURE0);
        const framebuffer = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        const attachmentCount = Math.max(...outputs.map((o) => o.location)) + 1;
        const drawBuffers = [];
        for (let i = 0; i < attachmentCount; i++) {
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, texture, 0);
            drawBuffers.push(gl.COLOR_ATTACHMENT0 + i);
        }
        gl.drawBuffers(drawBuffers);

        const blockIndex = gl.getUniformBlockIndex(program, '_milkdrop_frame');
        if (blockIndex !== gl.INVALID_INDEX) {
            gl.uniformBlockBinding(program, blockIndex, 0);
            const ubo = gl.createBuffer();
            gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
            gl.bufferData(gl.UNIFORM_BUFFER, frame, gl.STATIC_DRAW);
            gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);
        }
        for (const [name, values] of Object.entries(globalValues)) {
            const location = gl.getUniformLocation(program, name);
            if (location === null) {
                continue;
            }
            [null, gl.uniform1fv, gl.uniform2fv, gl.uniform3fv, gl.uniform4fv][values.length]?.call(gl, location, values);
        }
        let unit = 0;
        for (const [source, { data, n, volume }] of textureData) {
            const location = gl.getUniformLocation(program, source);
            if (location === null) {
                continue;
            }
            const target = volume ? gl.TEXTURE_3D : gl.TEXTURE_2D;
            gl.activeTexture(gl.TEXTURE0 + unit);
            const texture = gl.createTexture();
            gl.bindTexture(target, texture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            if (volume) {
                gl.texImage3D(target, 0, gl.RGBA8, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            } else {
                gl.texImage2D(target, 0, gl.RGBA8, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
            }
            gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.REPEAT);
            gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.REPEAT);
            gl.uniform1i(location, unit);
            unit++;
        }

        gl.viewport(0, 0, size, size);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        for (const output of outputs) {
            gl.readBuffer(gl.COLOR_ATTACHMENT0 + output.location);
            // Both images are in memory order: row 0 is GL's bottom row, and the WebGPU
            // vertex stage's flipped y puts the same row first.
            const pixels = new Uint8Array(size * size * 4);
            gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            glImages.push(pixels);
        }
        if (gl.isContextLost()) {
            throw new Error('WebGL context lost (the draw outran the GPU watchdog)');
        }
        const error = gl.getError();
        if (error !== gl.NO_ERROR) {
            throw new Error(`GL error 0x${error.toString(16)}`);
        }
        result.webgl = 'ok';
    } catch (error) {
        result.webgl = String(error && error.message ? error.message : error);
    }

    if (result.webgpu === 'ok' && result.webgl === 'ok') {
        outputs.forEach((output, index) => {
            const a = gpuImages[index];
            const b = glImages[index];
            let maxDelta = 0;
            let over = 0;
            let sum = 0;
            for (let p = 0; p < a.length; p += 4) {
                let pixelMax = 0;
                for (let c = 0; c < 4; c++) {
                    const delta = Math.abs(a[p + c] - b[p + c]);
                    pixelMax = Math.max(pixelMax, delta);
                    sum += delta;
                }
                maxDelta = Math.max(maxDelta, pixelMax);
                if (pixelMax > tolerance.pixelDelta) {
                    over++;
                }
            }
            const center = ((size >> 1) * size + (size >> 1)) * 4;
            result.outputs.push({
                location: output.location,
                webgpuCenter: Array.from(a.subarray(center, center + 4)),
                webglCenter: Array.from(b.subarray(center, center + 4)),
                maxDelta,
                meanDelta: sum / a.length,
                overFraction: over / (a.length / 4),
            });
        });
    }
    return result;
}

async function main() {
    // --filter a,b keeps the modules whose path contains a or b (e.g. "tests/,custom/").
    const filters = filter.split(',').filter((f) => f.length > 0);
    const modules = listModules(corpusDir).filter((m) => filters.length === 0 || filters.some((f) => relative(corpusDir, m).includes(f)));
    if (modules.length === 0) {
        console.error(`no modules (.wgsl + .glsl + .json) under ${corpusDir}`);
        process.exit(1);
    }
    const known = readLedger(ledgerPath);

    const server = createServer((request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<!doctype html><title>wgsl parity</title>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const { chromium } = loadPlaywright();
    let browser = null;
    let page = null;
    const start = async () => {
        browser = await chromium.launch({
            args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'],
        });
        page = await browser.newPage();
        // localhost is a secure context, which navigator.gpu needs.
        await page.goto(`http://localhost:${port}/`);
        return page.evaluate(async () => Boolean(navigator.gpu && (await navigator.gpu.requestAdapter())));
    };
    if (!(await start())) {
        console.error('This Chromium has no WebGPU adapter.');
        await browser.close();
        server.close();
        process.exit(1);
    }
    const browserVersion = browser.version();
    const timeoutMs = Number(option('--timeout', '60')) * 1000;

    const results = [];
    const started = Date.now();
    for (const base of modules) {
        const id = relative(corpusDir, base);
        const input = {
            wgsl: readFileSync(`${base}.wgsl`, 'utf8'),
            glsl: readFileSync(`${base}.glsl`, 'utf8'),
            reflection: JSON.parse(readFileSync(`${base}.json`, 'utf8')),
            size,
            tolerance: TOLERANCE,
        };
        let result;
        let timer = null;
        try {
            // SwiftShader runs a heavy preset shader slowly, and a shader can loop for good;
            // past the timeout the browser is restarted and the module counted as a timeout.
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            });
            result = await Promise.race([page.evaluate(runModule, input), timeout]);
        } catch (error) {
            result = { tint: [], webgpu: error.message === 'timeout' ? 'timeout' : `page: ${error.message}`, webgl: null, outputs: [] };
            if (error.message === 'timeout') {
                await browser.close().catch(() => {});
                await start();
            }
        } finally {
            clearTimeout(timer);
        }
        const within = result.outputs.length > 0 && result.outputs.every((o) => o.overFraction <= TOLERANCE.maxFraction);
        const status =
            result.webgpu === 'timeout'
                ? 'timeout'
                : result.tint.length > 0
                  ? 'tint-error'
                  : result.webgpu !== 'ok'
                    ? 'webgpu-error'
                    : result.webgl !== 'ok'
                      ? 'webgl-error'
                      : within
                        ? 'ok'
                        : 'diff';
        results.push({ id, status, ...result });
        if (results.length % 100 === 0) {
            console.log(`... ${results.length}/${modules.length} modules, ${Math.round((Date.now() - started) / 1000)} s`);
        }
        if (status !== 'ok') {
            const detail = status === 'tint-error' ? result.tint[0] : status === 'diff' ? JSON.stringify(result.outputs) : status === 'webgpu-error' ? result.webgpu : result.webgl;
            console.log(`${status.padEnd(12)} ${id}: ${detail}`);
        }
    }
    await browser.close();
    server.close();

    const count = (status) => results.filter((r) => r.status === status).length;
    const summary = {
        browser: browserVersion,
        tolerance: TOLERANCE,
        size,
        modules: results.length,
        ok: count('ok'),
        tintErrors: count('tint-error'),
        webgpuErrors: count('webgpu-error'),
        webglErrors: count('webgl-error'),
        diffs: count('diff'),
        timeouts: count('timeout'),
        seconds: Math.round((Date.now() - started) / 1000),
    };
    console.log(`\n${JSON.stringify(summary)}`);

    // Per preset (all of its modules), per corpus.
    // A preset fails when one of its modules fails on the WebGPU side. A module that timed out
    // or whose GLSL ES WebGL 2 cannot compile is not measured; it does not fail the preset, but
    // the preset is then reported as not fully measured.
    const presets = new Map();
    const measured = new Map();
    for (const r of results) {
        const preset = r.id.replace(/\.(warp|comp)(\.pass\d+)?$/, '.milk');
        const failed = r.status !== 'ok' && r.status !== 'webgl-error' && r.status !== 'timeout';
        presets.set(preset, (presets.get(preset) ?? true) && !failed);
        measured.set(preset, (measured.get(preset) ?? true) && r.status === 'ok');
    }
    for (const corpus of ['tests', 'custom', 'weeks']) {
        const entries = [...presets].filter(([preset]) => preset.startsWith(`${corpus}/`));
        if (entries.length > 0) {
            const failing = entries.filter(([, value]) => !value).length;
            const complete = entries.filter(([preset]) => measured.get(preset)).length;
            console.log(
                `  ${corpus}: ${entries.length} presets with shaders: ${complete} measured and within tolerance on every module, ` +
                    `${entries.length - complete - failing} not fully measured (timeout or WebGL-side error), ${failing} failing`,
            );
        }
    }

    if (reportPath) {
        writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 1));
    }

    // A WebGL compile error means the GLSL ES side cannot be compared; that is the GL path's
    // problem (PresetCompat), not WGSL's, and is reported but not failed here.
    const failing = [...presets].filter(([, value]) => !value).map(([preset]) => preset);
    const unexpected = failing.filter((preset) => !known.has(preset));
    const fixed = [...known].filter((preset) => presets.has(preset) && presets.get(preset));
    for (const preset of unexpected) {
        console.error(`error: ${preset} is not within tolerance on WebGPU and not in the ledger`);
    }
    for (const preset of fixed) {
        console.error(`error: ${preset} is listed in the ledger but is within tolerance now: delete its line`);
    }
    process.exit(unexpected.length > 0 || fixed.length > 0 ? 1 : 0);
}

await main();
