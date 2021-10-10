document.getElementById('btn2').style="background-color:white;position:absolute;display:block;left:3%;top:3%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn').addEventListener('click',function(){
document.getElementById("di").click();
let bz=new BroadcastChannel('bez');
bz.postMessage({
data:222
});
document.getElementById('btn3').style="background-color:red;position:absolute;display:block;left:3%;top:13%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById('btn4').style="background-color:grey;position:absolute;display:block;left:3%;top:33%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn5').style="background-color:pink;position:absolute;display:block;left:3%;top:43%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn6').style="background-color:yellow;position:absolute;display:block;left:3%;top:53%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn7').style="background-color:red;position:absolute;display:block;left:3%;top:63%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById('btn').style="background-color:red;position:absolute;display:block;left:3%;top:23%;z-index:999997;border:5px solid red;border-radius:50%;"
});
let fll=new BroadcastChannel('file');
fll.addEventListener('message',ea=> {
let fill=new Uint8Array(ea.data.data);
FS.writeFile('/sample.wav',fill);
Module.ccall("pl");
});
document.getElementById('btn3').addEventListener('click',function(){
window.open('https://test.1ink.us/libflac.js/');
});
document.getElementById('btn2').addEventListener('click',function(){
var hhh=Math.round(parseInt(window.innerHeight));
var www=Math.round(parseInt(window.innerWidth));
let pth="./presets/"+document.getElementById('path').innerHTML;
let pth2="./presets/"+document.getElementById('path2').innerHTML;
let pth3="./presets/"+document.getElementById('path3').innerHTML;
let pth4="./presets/"+document.getElementById('path4').innerHTML;
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
FS.writeFile('/presets/'+pth,fil);
console.log('File: '+pth'.');
}}
ff.send(null);
ff2.open("GET",pth2,true);
ff2.responseType="arraybuffer";
ff2.onload=function(oEvent){
var arrayBuffer2=ff2.response;
if(arrayBuffer2){
var fil=new Uint8ClampedArray(arrayBuffer2);
FS.writeFile('/presets/'+pth2,fil);
console.log('File: '+pth2'.');
}}
ff2.send(null);
ff3.open("GET",pth3,true);
ff3.responseType="arraybuffer";
ff3.onload=function(oEvent){
var arrayBuffer3=ff3.response;
if(arrayBuffer3){
var fil=new Uint8ClampedArray(arrayBuffer3);
FS.writeFile('/presets/'+pth3,fil);
console.log('File: '+pth3'.');
}}
ff3.send(null);
ff4.open("GET",pth4,true);
ff4.responseType="arraybuffer";
ff4.onload=function(oEvent){
var arrayBuffer4=ff4.response;
if(arrayBuffer4){
var fil=new Uint8ClampedArray(arrayBuffer4);
FS.writeFile('/presets/'+pth4,fil);
console.log('File: '+pth4+'.');
}}
ff4.send(null);
document.getElementById("ihig").innerHTML=hhh;
document.getElementById("bz").height=hhh;
document.getElementById("bz").width=www;
document.getElementById('btn3').style.border="5px solid green";
document.getElementById('btn2').style.border="5px solid red";
document.getElementById('btn2').style.background="red";
document.getElementById('btn').style.border="5px solid green";
document.getElementById('btn7').style.border="5px solid green";
document.getElementById('di').click();
document.getElementById('btn6').click();
});
document.getElementById('btn6').addEventListener('click',function(){
var hhh=Math.round(parseInt(window.innerHeight));
var www=Math.round(parseInt(window.innerWidth));
document.getElementById("bz").height=hhh;
document.getElementById("bz").width=www;
let midl=Math.round((www*0.5)-(hhh*0.5));
document.getElementById("contain2").height=hhh;
document.getElementById("contain2").width=www;
document.getElementById("canvas").style="position:absolute;z-index:999995;top:0px;bottom:0px;left:0px;right:0px;";
document.getElementById("vcanvas").style="position:absolute;z-index:999994;top:0px;bottom:0px;left:0px;right:0px;";
document.getElementById('ihig').innerHTML=hhh;
document.getElementById('iwid').innerHTML=www;
document.getElementById('di').click();
});
