let fll=new BroadcastChannel('file');
fll.addEventListener('message',ea=> {
let fill=new Uint8Array(ea.data.data);
FS.writeFile('/sample.wav',fill);
document.getElementById("ihig").innerHTML=window.innerHeight;
document.getElementById("circle").height=window.innerHeight;
document.getElementById("circle").width=window.innerWidth;
document.getElementById("dis").click();
});
