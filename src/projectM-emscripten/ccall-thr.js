parent.document.getElementById('dis').addEventListener('click',function(){
Module.ccall("pl");
});
parent.document.getElementById('btn5').addEventListener('click',function(){
Module.ccall("lck");
});
var pos3=0,pos4=0;
function clack(e){
pos3=e.clientX;
pos4=e.clientY;
var cords=[pos3,pos4];
Module.ccall("tch",null,['number','number'],cords);
};
