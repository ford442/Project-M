parent.document.getElementById('btn4').addEventListener('click',function(){
Module.ccall("swtch");
});
parent.document.getElementById('btn').addEventListener('click',function(){
Module.ccall('chng');
});
parent.document.getElementById("circle").width=window.innerWidth;
parent.document.getElementById("circle").height=window.innerHeight;
parent.document.getElementById("contain2").width=window.innerHeight;
parent.document.getElementById("contain2").height=window.innerHeight;
parent.document.getElementById('btn3').addEventListener('click',function(){
window.open('https://test.1ink.us/libflac.js/');
});
let bz=new BroadcastChannel('bez');
parent.document.getElementById('btn').addEventListener('click',function(){
let hi=window.innerHeight;
let wi=window.innerWidth;
parent.document.getElementById("ihig").innerHTML=hi;
parent.document.getElementById("iwid").innerHTML=hi;
parent.document.getElementById("circle").width=wi;
parent.document.getElementById("circle").height=hi;
parent.document.getElementById("canvas").style="width:"+window.innerHeight+"px;height:"+window.innerHeight+"px;";
let mid=Math.round((wi*0.5)-(hi*0.5));
let rmid=wi-mid;
parent.document.getElementById("contain2").style="pointer-events:none;z-index:999992;height:"+hi+"px;width:"+hi+"px;position:absolute;bottom:0px;left:"+mid+"px;";
parent.document.getElementById("di").click();
bz.postMessage({
data:222
});
});
