var MyModule =
{
    canvas: (function() {
    var aCanvas = document.getElementById('canvas');
  //  aGlCtx = aCanvas.getContext ('webgl2',  { alpha: true, premultipliedAlpha: false, depth: false, antialias: false, preserveDrawingBuffer: false } ); 
    return aCanvas;
  })(),
    preRun: (function() {
FS.mkdir('/presets');
FS.mkdir('/snd');
FS.mkdir('/textures');
var id = FS.makedev(64, 0);
FS.registerDevice(id, {});
FS.mkdev('/presets', id);
var id2 = FS.makedev(128, 0);
FS.registerDevice(id2, {});
FS.mkdev('/snd', id2);
})(),

};

const OccViewerModuleInitialized = createModule(MyModule);
