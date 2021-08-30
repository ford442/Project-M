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
pos3=e.clientX;
pos4=e.clientY;
var cords=[pos3,pos4];
Module.ccall("tchd",null,['number','number'],cords);
document.onmouseup=closeDragElement();
};
function clack(e){
pos3=e.clientX;
pos4=e.clientY;
var cords=[pos3,pos4];
Module.ccall("tch",null,['number','number'],cords);
};
});
