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
document.getElementById("contain2").style="z-index:999993;height:1440px;width:1440px;position:absolute;top:0px;left:0px;";
document.getElementById("canvas").style="position:absolute;left:0;top:0;background-color:rgba(1,1,1,0);z-index:999995;image-rendering:pixelated;width:1440px;height:1440px;";
document.getElementById('ihig').innerHTML=1440;
document.getElementById('iwid').innerHTML=1440;
document.getElementById('btn4').style="background-color:grey;position:absolute;display:block;left:3%;top:33%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn5').style="background-color:pink;position:absolute;display:block;left:3%;top:43%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn3').style="background-color:red;position:absolute;display:block;left:3%;top:13%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById('btn6').style="background-color:yellow;position:absolute;display:block;left:3%;top:53%;z-index:999997;border:5px solid green;border-radius:50%;";
document.getElementById('btn').style="background-color:red;position:absolute;display:block;left:3%;top:23%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById('btn7').style="background-color:red;position:absolute;display:block;left:3%;top:63%;z-index:999997;border:5px solid red;border-radius:50%;";
document.getElementById('shut').innerHTML=2;
document.getElementById('di').click();
Module.ccall("chng");
});
