// Stand-in for html/projectm-render-worker.js in the iframe → host → worker
// smoke: counts the PCM the host's worker transport posts here.
let frames = 0;
let chunks = 0;
let channels = null;
self.onmessage = (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'pcm' || !(msg.buffer instanceof Float32Array)) return;
    channels = msg.channels;
    chunks += 1;
    frames += msg.channels === 1 ? msg.buffer.length : msg.buffer.length >> 1;
    self.postMessage({ frames, chunks, channels });
};
