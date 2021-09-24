document.getElementById('btn5').addEventListener('click',function(){
Module.ccall("lck");
});
document.getElementById('btn4').addEventListener('click',function(){
Module.ccall("swtch");
});
document.getElementById('btn').addEventListener('click',function(){
Module.ccall('chng');
});

Module.preInit=(function(){
let hdid=FS.makedev(64,0);
let hdid2=FS.makedev(128,0);
FS.registerDevice(hdid,{});
FS.registerDevice(hdid2,{});
FS.mkdir('/presets');
FS.mkdir('/textures');
FS.mkdev('/',hdid);
FS.mkdev('/presets',hdid2);
FS.init();
FS.mount(MEMFS,{},'/');
FS.mount(MEMFS,{},'/presets');
});
