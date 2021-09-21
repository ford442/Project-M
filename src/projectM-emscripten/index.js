var MyModule =
{
    canvas: (function() {
    var aCanvas = document.getElementById('canvas');
  //  aGlCtx = aCanvas.getContext ('webgl2',  { alpha: true, premultipliedAlpha: false, depth: false, antialias: false, preserveDrawingBuffer: false } ); 
    return aCanvas;
  })(),

};

const OccViewerModuleInitialized = createModule(MyModule);
