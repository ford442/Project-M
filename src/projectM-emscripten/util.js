

document.getElementById("circle").width=window.innerWidth;
document.getElementById("circle").height=window.innerHeight;
document.getElementById("contain2").width=window.innerHeight;
document.getElementById("contain2").height=window.innerHeight;
document.getElementById('btn3').addEventListener('click',function(){
window.open('https://test.1ink.us/libflac.js/');
});
let bz=new BroadcastChannel('bez');
document.getElementById('btn').addEventListener('click',function(){
let hi=window.innerHeight;
let wi=window.innerWidth;
document.getElementById("ihig").innerHTML=hi;
document.getElementById("iwid").innerHTML=hi;
document.getElementById("circle").width=wi;
document.getElementById("circle").height=hi;
document.getElementById("canvas").style="width:"+window.innerHeight+"px;height:"+window.innerHeight+"px;";
let mid=Math.round((wi*0.5)-(hi*0.5));
let rmid=wi-mid;
document.getElementById("contain2").style="pointer-events:none;z-index:999992;height:"+hi+"px;width:"+hi+"px;position:absolute;bottom:0px;left:"+mid+"px;";
document.getElementById("di").click();
bz.postMessage({
data:222
});
});
var statusElement=document.getElementById('status');
var progressElement=document.getElementById('progress');
var Module={
preRun:[],postRun:[],print:(function(){
var element=document.getElementById('output');
if(element) element.value='';
return function(text){
if(arguments.length>1) text=Array.prototype.slice.call(arguments).join(' ');
console.log(text);
if(element){
element.value+=text+"\n";
element.scrollTop=element.scrollHeight;
}
};
})(),printErr:function(text){
if(arguments.length>1) text=Array.prototype.slice.call(arguments).join(' ');
if(0){
dump(text+'\n');
}else{
console.error(text);
}
},canvas:(function(){
var canvas=document.getElementById('canvas');
canvas.addEventListener("webglcontextlost",function(e){
alert('WebGL context lost. You will need to reload the page.');
e.preventDefault();
},false);
return canvas;
})(),setStatus:function(text){
if(!Module.setStatus.last) Module.setStatus.last={
time:Date.now(),text:''
};
if(text === Module.setStatus.text) return;
var m=text.match(/([^(]+)\((\d+(\.\d+)?)\/(\d+)\)/);
var now=Date.now();
if(m && now-Date.now()<30) return; // if this is a progress update, skip it if too soon
if(m){
text=m[1];
progressElement.value=parseInt(m[2])*100;
progressElement.max=parseInt(m[4])*100;
progressElement.hidden=false;
}else{
progressElement.value=null;
progressElement.max=null;
progressElement.hidden=true;
}
statusElement.innerHTML=text;
},totalDependencies:0,monitorRunDependencies:function(left){
this.totalDependencies=Math.max(this.totalDependencies,left);
Module.setStatus(left?'Preparing... ('+(this.totalDependencies-left)+'/'+this.totalDependencies+')':'All downloads complete.');
}};
Module.setStatus('Downloading...');
window.onerror=function(event){
Module.setStatus('Exception thrown, see JavaScript console');
Module.setStatus=function(text){
if(text) Module.printErr('[post-exception status] '+text);
};};
