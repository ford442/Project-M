let bz=new BroadcastChannel('bez');
document.getElementById('btn').addEventListener('click',function(){
let hi=window.innerHeight;
let wi=window.innerWidth;
document.getElementById("ihig").innerHTML=hi;
document.getElementById("iwid").innerHTML=hi;
document.getElementById("circle").width=wi;
document.getElementById("circle").height=hi;
document.getElementById("canvas").style="background-color:rgba(0,0,0,1);z-index:999995;image-rendering:pixelated;width:"+window.innerHeight+"px;height:"+window.innerHeight+"px;";
let mid=Math.round((wi*0.5)-(hi*0.5));
let rmid=wi-mid;
document.getElementById("contain2").style="background-color:black;pointer-events:none;z-index:999993;height:"+hi+"px;width:"+hi+"px;position:absolute;bottom:0px;left:"+mid+"px;";
document.getElementById("di").click();
bz.postMessage({
data:222
});});
let fll=new BroadcastChannel('file');
fll.addEventListener('message',ea=> {
let fill=new Uint8Array(ea.data.data);
FS.writeFile('/sample.wav',fill);
Module.ccall("pl");
});
document.getElementById('btn2').addEventListener('click',function(){
let pth=document.getElementById('path').innerHTML;
let pth2=document.getElementById('path2').innerHTML;
let pth3=document.getElementById('path3').innerHTML;
let pth4=document.getElementById('path4').innerHTML;
let ff=new XMLHttpRequest();
let ff2=new XMLHttpRequest();
let ff3=new XMLHttpRequest();
let ff4=new XMLHttpRequest();
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
ff2.open("GET",pth2,true);
ff2.responseType="arraybuffer";
ff2.onload=function(oEvent){
var arrayBuffer2=ff2.response;
if(arrayBuffer2){
var fil=new Uint8ClampedArray(arrayBuffer2);
FS.writeFile('/presets/set2.milk',fil);
console.log('File: set2.milk.');
}}
ff2.send(null);
ff3.open("GET",pth3,true);
ff3.responseType="arraybuffer";
ff3.onload=function(oEvent){
var arrayBuffer3=ff3.response;
if(arrayBuffer3){
var fil=new Uint8ClampedArray(arrayBuffer3);
FS.writeFile('/presets/set3.milk',fil);
console.log('File: set3.milk.');
}}
ff3.send(null);
ff4.open("GET",pth4,true);
ff4.responseType="arraybuffer";
ff4.onload=function(oEvent){
var arrayBuffer4=ff4.response;
if(arrayBuffer4){
var fil=new Uint8ClampedArray(arrayBuffer4);
FS.writeFile('/presets/set4.milk',fil);
console.log('File: set4.milk.');
}}
ff4.send(null);
});
