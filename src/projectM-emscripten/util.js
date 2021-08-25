document.getElementById('btn4').addEventListener('click',function(){
Module.ccall("swtch");
});
document.getElementById('btn').addEventListener('click',function(){
Module.ccall('chng');
// document.getElementById('btn4').style="border-color:green;background-color: grey;position: absolute;display: block;left: 20%;top: 50%;z-index: 999997;border:5px solid;border-radius:50%;";
});
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
