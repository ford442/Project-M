#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <projectM.hpp>
#include <emscripten/emscripten.h>
#include <GLES3/gl3.h>
#include "SDL2/SDL_config.h"
#include <SDL2/SDL.h>
#include <pthread.h>

const float FPS=60;
static SDL_AudioDeviceID dev;
static struct{
SDL_AudioSpec spec;
Uint8 *snd;
Uint32 slen;
int pos;
}wave;
typedef struct{
projectM *pm;
SDL_Window *win;
SDL_GLContext *glCtx;
bool done;
projectM::Settings settings;
SDL_AudioDeviceID dev;
}
projectMApp;
projectMApp app;
void renderFrame(){
unsigned char **sndBuf=&wave.snd;
auto sndat=reinterpret_cast<short*>(sndBuf);
unsigned int ll=sizeof(sndBuf);
app.pm->pcm()->addPCM16Data(sndat,ll);
glClearColor(0.0,0.5,0.0,0.5);
glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
app.pm->renderFrame();
glFlush();
SDL_GL_SwapWindow(app.win);
}
static void cls_aud(){
if(dev!=0){
SDL_PauseAudioDevice(dev,SDL_TRUE);
SDL_CloseAudioDevice(dev);
dev=0;
}}
static void qu(int rc){
SDL_Quit();exit(rc);
}
static void opn_aud(){
dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);
if(!dev){
SDL_FreeWAV(wave.snd);
qu(2);
}
SDL_PauseAudioDevice(dev,SDL_FALSE);
}
void SDLCALL bfr(void *unused,Uint8 * stm,int len){
Uint8 *wptr;
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
void *chngt(void *b){
SDL_Init(SDL_INIT_VIDEO);
int width=EM_ASM_INT({
return document.getElementById('ihig').innerHTML;
});
int height=width;
app.win=SDL_CreateWindow("pm",SDL_WINDOWPOS_UNDEFINED,SDL_WINDOWPOS_UNDEFINED,width,height,SDL_WINDOW_OPENGL);
SDL_GLContext glCtx=SDL_GL_CreateContext(app.win);
app.glCtx=&glCtx;
SDL_SetWindowTitle(app.win,"Happy New Year 1999!!!!!!!!!!!!");
SDL_Log("GL_VERSION: %s",glGetString(GL_VERSION));
SDL_Log("GL_SHADING_LANGUAGE_VERSION: %s",glGetString(GL_SHADING_LANGUAGE_VERSION));
app.settings.meshX=64;
app.settings.meshY=64;
app.settings.fps=FPS;
app.settings.textureSize=4096;
app.settings.windowWidth=width;
app.settings.windowHeight=width;
app.settings.smoothPresetDuration=17;
app.settings.presetDuration=EM_ASM_INT({
return document.getElementById('dura').innerHTML;
});
app.settings.beatSensitivity=1;
app.settings.aspectCorrection=0;
app.settings.easterEgg=0;
app.settings.shuffleEnabled=1;
app.settings.softCutRatingsEnabled=1;
app.settings.presetURL="/presets";
app.pm=new projectM(app.settings);
printf("Init ProjectM\n");
app.pm->selectRandom(true);
printf("Select random preset.\n");
app.pm->projectM_resetGL(width,height);
printf("Reseting GL.\n");
DIR *m_dir;
if ((m_dir=opendir("/")) == NULL){
printf("error opening /\n");
}else{
struct dirent *dir_entry;
while ((dir_entry=readdir(m_dir)) != NULL){
printf("%s\n",dir_entry->d_name);
}}
for (uint i=0;i < app.pm->getPlaylistSize();i++){
printf("%d\t%s\n",i,app.pm->getPresetName(i).c_str());
}
emscripten_set_main_loop((void (*)())renderFrame,120,1);
}
void *plt(void *b){
cls_aud();
char flnm[256];
SDL_FreeWAV(wave.snd);
SDL_Quit();
SDL_SetMainReady();
if (SDL_Init(SDL_INIT_AUDIO)<0){qu(1);}
SDL_strlcpy(flnm,"/sample.wav",sizeof(flnm));
if(SDL_LoadWAV(flnm,&wave.spec,&wave.snd,&wave.slen)==NULL){
qu(1);
}
wave.pos=0;
wave.spec.callback=bfr;
opn_aud();
}
extern "C" {
void swtch(){
app.pm->selectRandom(true);
}
void lck(){
app.pm->setPresetLock(true);
}
pthread_t change;
pthread_t play;
void chng(){
pthread_create(&change, NULL, &chngt, NULL);
}
void pl(){
pthread_create(&play, NULL, &plt, NULL);
}}
int main(){
MAIN_THREAD_EM_ASM({
let fll=new BroadcastChannel('file');
fll.addEventListener('message',ea=> {
let fill=new Uint8Array(ea.data.data);
FS.writeFile('/sample.wav',fill);
document.getElementById("ihig").innerHTML=window.innerHeight;
document.getElementById("circle").height=window.innerHeight;
document.getElementById("circle").width=window.innerWidth;
document.getElementById("dis").click();
});  
 
document.getElementById('btn2').addEventListener('click',function(){
let pth=document.getElementById('path').innerHTML;
let pth2=document.getElementById('path2').innerHTML;
let pth3=document.getElementById('path3').innerHTML;
let pth4=document.getElementById('path4').innerHTML;
let ff=new XMLHttpRequest();
let ff2=new XMLHttpRequest();
let ff3=new XMLHttpRequest();
let ff4=new XMLHttpRequest();
ff.open("GET",pth,true);
ff.responseType="arraybuffer";
ff.onload=function(oEvent){
var arrayBuffer=ff.response;
if(arrayBuffer){
var fil=new Uint8ClampedArray(arrayBuffer);
FS.writeFile('/presets/set1.milk',fil);
}};
  
ff.send(null);    
 
ff2.open("GET",pth2,true);
ff2.responseType="arraybuffer";
ff2.onload=function(oEvent){
var arrayBuffer2=ff2.response;
if(arrayBuffer2){
var fil=new Uint8ClampedArray(arrayBuffer2);
FS.writeFile('/presets/set2.milk',fil);
}};
ff2.send(null);
 
 /*
ff3.open("GET",pth3,true);
ff3.responseType="arraybuffer";
ff3.onload=function(oEvent){
var arrayBuffer3=ff3.response;
if(arrayBuffer3){
var fil=new Uint8ClampedArray(arrayBuffer3);
FS.writeFile('/presets/set3.milk',fil);
}}
ff3.send(null);
ff4.open("GET",pth4,true);
ff4.responseType="arraybuffer";
ff4.onload=function(oEvent){
var arrayBuffer4=ff4.response;
if(arrayBuffer4){
var fil=new Uint8ClampedArray(arrayBuffer4);
FS.writeFile('/presets/set4.milk',fil);
}}
ff4.send(null);
});
  
document.getElementById('dis').addEventListener('click',function(){
Module.ccall("pl");
});
document.getElementById('btn5').addEventListener('click',function(){
Module.ccall("lck");
});
  document.getElementById('btn4').addEventListener('click',function(){
Module.ccall("swtch");
});
document.getElementById('btn').addEventListener('click',function(){
Module.ccall('chng');
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
}); */
});
});
app.done=0;
return 1;
}
