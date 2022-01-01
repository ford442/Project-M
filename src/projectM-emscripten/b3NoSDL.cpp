#include <string>
#include <cstdarg>
#include <cstdbool>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <emscripten.h>
#include <emscripten/html5.h>

EM_JS(void,ma,(),{
let d=S();if(d)d();d=S();function S(){
let w$=parseInt(document.getElementById("iwid").innerHTML,10);
let h$=parseInt(document.getElementById("ihig").innerHTML,10);
w$=Math.round(w$);h$=Math.round(h$);let canvas=document.getElementById("vcanvas");
let contx=canvas.getContext('webgl2',{alpha:true,stencil:false,depth:true,premultipliedAlpha:false,imageSmoothingEnabled:false,lowLatency:true,powerPreference:'high-performance',majorVersion:2});
const g=new GPU({canvas:canvas,webGl:contx});
let Rn=parseInt(document.getElementById("frate").innerHTML,10);
let l=(w$*h$*4);let m=((l/65536)+1);m=Math.floor(m);
let W=new WebAssembly.Memory({initial:m});let o=[w$,h$];
const v=document.getElementById("mv");
const t=g.createKernel(function(v){const P=v[this.thread.y][this.thread.x];
return[P[0],P[1],P[2]];}).setTactic("precision").setPipeline(true).setOutput(o);
const r=g.createKernel(function(f){const p=f[this.thread.y][this.thread.x];
this.color(p[0],p[1],p[2]);}).setTactic("precision").setGraphical(true).setOutput(o);
let $=new Uint8ClampedArray(W.buffer,0,l);$.set(t(v),0);r(t($));
$.set(t(v),0);r(t($));$.set(t(v),0);let T=false;let ms=1;let R=16;let f=(1000/Rn);
function M(){if(T){return;}r(t($));$.set(t(v),0);let mq=((ms*f)/R);let k=Math.floor(mq);
let y=((k*f)-(k*Rn));if(y>8){R=8;}ms=ms+1;setTimeout(function(){M();},R);}M();
document.getElementById("di").onclick=function(){T=true;t.destroy();r.destroy();g.destroy();S();};return()=>{T=true;};}});
int main(){
ma();
return 1;
}
