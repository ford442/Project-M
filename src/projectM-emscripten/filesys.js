let fll=new BroadcastChannel('file');
fll.addEventListener('message',ea=> {
let fill=new Uint8Array(ea.data.data);
FS.writeFile('/sample.wav',fill);
document.getElementById("ihig").innerHTML=window.innerHeight;
document.getElementById("circle").height=window.innerHeight;
document.getElementById("circle").width=window.innerWidth;
document.getElementById("dis").click();
});
document.getElementById('btn2').addEventListener('click',function(){
let pth=document.getElementById('path').innerHTML;
let ff=new XMLHttpRequest();
ff.open("GET",pth,true);
ff.responseType="arraybuffer";
ff.onload=function(oEvent){
var arrayBuffer=ff.response;
if(arrayBuffer){
var fil=new Uint8ClampedArray(arrayBuffer);
FS.writeFile('/presets/tst.milk',fil);
console.log('File written to /presets/tst.milk.');
}}
ff.send(null);
});
document.getElementById('btn').addEventListener('click',function(){
Module.ccall('chng');
});
