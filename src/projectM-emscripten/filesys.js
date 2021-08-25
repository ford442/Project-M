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
let pth2=document.getElementById('path2').innerHTML;
let pth3=document.getElementById('path3').innerHTML;
let ff=new XMLHttpRequest();
ff.open("GET",pth,true);
ff.responseType="arraybuffer";
ff.onload=function(oEvent){
var arrayBuffer=ff.response;
if(arrayBuffer){
var fil=new Uint8ClampedArray(arrayBuffer);
FS.writeFile('/presets/set1.milk',fil);
console.log('File: set1.milk.');
}}
ff.send(null);
ff.open("GET",pth2,true);
ff.responseType="arraybuffer";
ff.onload=function(oEvent){
var arrayBuffer=ff.response;
if(arrayBuffer){
var fil=new Uint8ClampedArray(arrayBuffer);
FS.writeFile('/presets/set2.milk',fil);
console.log('File: /set2.milk.');
}}
ff.send(null);
ff.open("GET",pth3,true);
ff.responseType="arraybuffer";
ff.onload=function(oEvent){
var arrayBuffer=ff.response;
if(arrayBuffer){
var fil=new Uint8ClampedArray(arrayBuffer);
FS.writeFile('/presets/set3.milk',fil);
console.log('File: set3.milk.');
}}
ff.send(null);
});
document.getElementById('btn').addEventListener('click',function(){
Module.ccall('chng');
});
