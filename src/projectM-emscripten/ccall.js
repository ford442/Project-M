document.getElementById('dis').addEventListener('click',function(){
Module.ccall("pl");
});
document.getElementById('btn5').addEventListener('click',function(){
Module.ccall("lck");
});
var pos3=0,pos4=0;
function closeDragElement(){
document.onmouseup=null;
document.onmousemove=null;
};
function dragMouseDown(e){
e=e||window.event;
e.preventDefault();
pos3=e.clientX;
pos4=e.clientY;
var cords=[pos3,pos4];
Module.ccall("tchd",null,[number,number],cords);
document.onmouseup=closeDragElement();
};
document.getElementById('canvas').onmousedown=dragMouseDown();
document.getElementById('canvas').addEventListener('click',function(){
function showCoords(event){
var x=event.clientX;
var y=event.clientY;
var coords=[x,y];
Module.ccall("tch",null,[number,number],coords);
});
