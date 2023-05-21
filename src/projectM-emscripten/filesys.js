
let bz=new BroadcastChannel('bez');
document.getElementById('btn').addEventListener('click',function(){
let hi=window.innerHeight;
let wi=window.innerWidth;
document.getElementById("ihig").innerHTML=hi;
document.getElementById("iwid").innerHTML=hi;
document.getElementById("circle").width=wi;
document.getElementById("circle").height=hi;
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

document.getElementById("circle").width=window.innerWidth;
document.getElementById("circle").height=window.innerHeight;
document.getElementById("contain2").width=window.innerHeight;
document.getElementById("contain2").height=window.innerHeight;
document.getElementById('btn3').addEventListener('click',function(){
window.open('./flac');
});
document.getElementById('btn2').addEventListener('click',function(){
document.getElementById("ihig").innerHTML=window.innerHeight;
document.getElementById("circle").height=window.innerHeight;
document.getElementById("circle").width=window.innerWidth;
document.getElementById('btn3').style.border="5px solid green";
document.getElementById('btn2').style.border="5px solid red";
document.getElementById('btn2').style.background="red";
document.getElementById('btn').style.border="5px solid green";
document.getElementById('btn7').style.border="5px solid green";
document.getElementById('di').click();
});
document.getElementById('btn').addEventListener('click',function(){
document.getElementById('btn3').style="background-color:red;position:absolute;display:block;left:3%;top:13%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById('btn4').style="background-color:grey;position:absolute;display:block;left:3%;top:33%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn5').style="background-color:pink;position:absolute;display:block;left:3%;top:43%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn6').style="background-color:yellow;position:absolute;display:block;left:3%;top:53%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn7').style="background-color:red;position:absolute;display:block;left:3%;top:63%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById('btn').style="background-color:red;position:absolute;display:block;left:3%;top:23%;z-index:999997;border:5px solid red;border-radius:50%;"
});
document.getElementById('btn6').addEventListener('click',function(){
let midl=(window.innerWidth*0.5)-(window.innerHeight*0.5);
document.getElementById("contain2").style="pointer-events:none;z-index:999993;height:"+window.innerHeight+"px;width:"+window.innerHeight+"px;position:absolute;top:0;left:"+midl+";right:"+midl+";";
document.getElementById("pcanvas").style="position:absolute;left:0;top:0;background-color:rgba(1,1,1,0);z-index:999995;image-rendering:auto;width:"+window.innerHeight+"px;height:"+window.innerHeight+"px;";
document.getElementById("bcanvas").style="z-index:999994;height:100vh;top:0;width:auto;position:absolute;text-align:center;background-color:rgba(0,0,0,1);";
document.getElementById('ihig').innerHTML=Math.round(window.innerHeight);
document.getElementById("circle").height=window.innerHeight;
document.getElementById("circle").width=window.innerWidth;
document.getElementById('di').click();
});
document.getElementById('btn7').addEventListener('click',function(){
document.getElementById('btn4').style="background-color:grey;position:absolute;display:block;left:3%;top:33%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn5').style="background-color:pink;position:absolute;display:block;left:3%;top:43%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn3').style="background-color:red;position:absolute;display:block;left:3%;top:13%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById("drop").style="background-color:rgba(0,0,0,1);z-index:999994;height:100vh;width:auto;position:absolute;text-align:center;";
document.getElementById('btn6').style="background-color:yellow;position:absolute;display:block;left:3%;top:53%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn').style="background-color:red;position:absolute;display:block;left:3%;top:23%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById('btn7').style="background-color:red;position:absolute;display:block;left:3%;top:63%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById('shut').innerHTML=2;
document.getElementById('di').click();
});
document.getElementById('btn2').addEventListener('click',function(){
let pth="./"+document.getElementById('path').innerHTML;
let pth2="./"+document.getElementById('path2').innerHTML;
let pth3="./"+document.getElementById('path3').innerHTML;
let pth4="./"+document.getElementById('path4').innerHTML;
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
