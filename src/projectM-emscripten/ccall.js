document.getElementById('btn5').addEventListener('click',function(){
Module.ccall("lck");
});
document.getElementById('btn4').addEventListener('click',function(){
Module.ccall("swtch");
});
document.getElementById('btn').addEventListener('click',function(){
Module.ccall('chng');
});
document.getElementById('btn7').addEventListener('click',function(){
Module.ccall('rst');
});


