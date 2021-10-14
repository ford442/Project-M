let MyModule =
{
preRun: (function() {
var id = FS.makedev(64, 0);
FS.registerDevice(id, {});
FS.mkdev('/presets', id);

var id2 = FS.makedev(128, 0);
FS.registerDevice(id2, {});
FS.mkdev('/snd', id2);
})(),
  
};
