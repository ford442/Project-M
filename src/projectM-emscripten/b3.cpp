#include <emscripten/emscripten.h>
#include "SDL2/SDL_config.h"
#include <SDL2/SDL.h>
static SDL_AudioDeviceID dev;
Uint8* stm;
static struct{SDL_AudioSpec spec;Uint8* snd;Uint32 slen;int pos;}wave;
static void cls_aud(){
if(dev!=0){
SDL_PauseAudioDevice(dev,SDL_TRUE);
SDL_CloseAudioDevice(dev);
dev=0;
}}
static void qu(int rc){
SDL_Quit();
exit(rc);
}
static void opn_aud(){
dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);
if(!dev){
SDL_FreeWAV(wave.snd);
qu(2);
}
SDL_PauseAudioDevice(dev,SDL_FALSE);
}
static void SDLCALL bfr(void *unused,Uint8* stm,int len){
Uint8* wptr;
int lft;
wptr=wave.snd+wave.pos;
lft=wave.slen-wave.pos;
while (lft<=len){
SDL_memcpy(stm,wptr,lft);
stm+=lft;
len-=lft;
wptr=wave.snd;
lft=wave.slen;
wave.pos=0;
}
SDL_memcpy(stm,wptr,len);
wave.pos+=len;
}
static void plt(){
cls_aud();
char flnm[1024];
SDL_FreeWAV(wave.snd);
SDL_Quit();
SDL_SetMainReady();
if (SDL_Init(SDL_INIT_AUDIO)<0){
qu(1);
}
SDL_strlcpy(flnm,"/snd/sample.wav",sizeof(flnm));
if(SDL_LoadWAV(flnm,&wave.spec,&wave.snd,&wave.slen)==NULL){qu(1);}
wave.pos=0;
wave.spec.callback=bfr;
opn_aud();
}
extern "C" {
void pl(){
plt();
}
EM_JS(void,ma,(),{let d=S();if(d)d();d=S();function S(){let w=parseInt(document.getElementById("iwid").innerHTML,10);let h=parseInt(document.getElementById("ihig").innerHTML,10);w=Math.round(w);h=Math.round(h);let canvas=document.getElementById("vcanvas");let contx=canvas.getContext('webgl2',{alpha:false,stencil:false,depth:false,premultipliedAlpha:false,imageSmoothingEnabled:false,lowLatency:true,powerPreference:'high-performance',majorVersion:2});const g=new GPU({canvas:canvas,webGl:contx});let Rn=parseInt(document.getElementById("frate").innerHTML,10);let l=(w*h*4);let m=((l/65536)+1);m=Math.floor(m);let W=new WebAssembly.Memory({initial:m});let o=[w,h];const v=document.getElementById("mv");const t=g.createKernel(function(v){const P=v[this.thread.y][this.thread.x];return[P[0],P[1],P[2]];}).setTactic("precision").setPipeline(true).setOutput(o).setStrictIntegers(true).setFixIntegerDivisionAccuracy(false);const r=g.createKernel(function(f){const p=f[this.thread.y][this.thread.x];this.color(p[0],p[1],p[2]);}).setTactic("precision").setGraphical(true).setOutput(o).setStrictIntegers(true).setFixIntegerDivisionAccuracy(false);let $=new Uint8ClampedArray(W.buffer,0,l);$.set(t(v),0);r(t($));$.set(t(v),0);r(t($));$.set(t(v),0);let T=false;let ms=1;let R=16;let f=(1000/Rn);function M(){if(T){return;}r(t($));$.set(t(v),0);let mq=((ms*f)/R);let k=Math.floor(mq);let y=((k*f)-(k*Rn));if(y>8){R=8;}ms=ms+1;setTimeout(function(){M();},R);}M();document.getElementById("di").onclick=function(){T=true;t.destroy();r.destroy();g.destroy();S();};return()=>{T=true;};}});
}
int main(){
EM_ASM({
FS.mkdir('/snd');
});
ma();
return 1;
}
