
#include <string>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES3/gl31.h>
#include <GLES3/gl32.h>

#include <SDL2/SDL.h>
#include "SDL2/SDL_config.h"

#include <unistd.h>
#include <algorithm>
#include <iostream>
#include <cstring>
#include <cmath>
#include <ctime>
#include <cstdarg>
#include <cstdbool>
#include <chrono>
#include <projectM.hpp>
#include <pthread.h>

using namespace std;
using namespace std::chrono;
struct timespec rem;
struct timespec req={0,1200000000};

#define GL_GLEXT_PROTOTYPES 1
#define GL3_PROTOTYPES 1
#define GL_FRAGMENT_PRECISION_HIGH 1
#define FLAG_DISABLE_PLAYLIST_LOAD 1

SDL_AudioDeviceID dev;
struct{SDL_AudioSpec spec;Uint8 *snd;Uint32 slen;int pos;}wave;
Uint8* stm;

typedef struct{projectM *pm;bool done;projectM::Settings settings;SDL_AudioDeviceID dev;}projectMApp;
projectMApp app;

int v0=0,v1=1,v2=2,v3=3,v4=4,v6=6,v8=8,v10=10,v16=16,v24=24,v32=32;
  
void renderFrame(){
glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);
app.pm->renderFrame();
glFlush();
auto sndat=reinterpret_cast<short*>(stm);
app.pm->pcm()->addPCM16Data(sndat,1024/sizeof(short));
glFinish();
}

void chngt(){
const float FPS=60;
EmscriptenWebGLContextAttributes attr;
EGLDisplay display;
EGLContext contextegl;
EGLSurface surface;
EGLint config_size,major,minor;
static EGLint anEglCtxAttribs2[]={
EGL_CONTEXT_CLIENT_VERSION,v3,
EGL_CONTEXT_MINOR_VERSION_KHR,v0,
// EGL_CONTEXT_PRIORITY_LEVEL_IMG,EGL_CONTEXT_PRIORITY_REALTIME_NV,
// EGL_COLOR_COMPONENT_TYPE_EXT,EGL_COLOR_COMPONENT_TYPE_FLOAT_EXT,
// EGL_CONTEXT_FLAGS_KHR,EGL_CONTEXT_OPENGL_FORWARD_COMPATIBLE_BIT_KHR,
// EGL_CONTEXT_FLAGS_KHR,EGL_CONTEXT_OPENGL_ROBUST_ACCESS_BIT_KHR,
EGL_NONE};
  
const EGLint attribut_list[]={
// EGL_GL_COLORSPACE_KHR,EGL_GL_COLORSPACE_SRGB_KHR,
EGL_NONE
};

const EGLint attribute_list[]={
// EGL_COLOR_COMPONENT_TYPE_EXT,EGL_COLOR_COMPONENT_TYPE_FLOAT_EXT,
// EGL_CONTEXT_OPENGL_PROFILE_MASK_KHR,EGL_CONTEXT_OPENGL_COMPATIBILITY_PROFILE_BIT_KHR,
EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,
// EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT,EGL_TRUE,
// EGL_DEPTH_ENCODING_NV,EGL_DEPTH_ENCODING_NONLINEAR_NV,
// EGL_RENDER_BUFFER,EGL_QUADRUPLE_BUFFER_NV,
// EGL_CONTEXT_OPENGL_FORWARD_COMPATIBLE,EGL_TRUE,
EGL_RED_SIZE,v8,
EGL_GREEN_SIZE,v8,
EGL_BLUE_SIZE,v8,
EGL_ALPHA_SIZE,v8,
EGL_DEPTH_SIZE,v24,
EGL_STENCIL_SIZE,v8,
EGL_BUFFER_SIZE,v32,
EGL_SAMPLE_BUFFERS,v1,
EGL_SAMPLES,v4,
EGL_NONE
};
  
attr.alpha=EM_TRUE;
attr.stencil=EM_TRUE;
attr.depth=EM_TRUE;
attr.antialias=EM_TRUE;
attr.premultipliedAlpha=EM_FALSE;
attr.preserveDrawingBuffer=EM_FALSE;
attr.enableExtensionsByDefault=EM_TRUE;
attr.powerPreference=EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
attr.failIfMajorPerformanceCaveat=EM_FALSE;
attr.majorVersion=v2;
attr.minorVersion=v0;
emscripten_webgl_init_context_attributes(&attr);
  
int S=EM_ASM_INT({return parseInt(window.innerHeight);});
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx=emscripten_webgl_create_context("#pcanvas",&attr);
EGLConfig eglconfig=NULL;
display=eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(display,&v3,&v0);
eglChooseConfig(display,attribute_list,&eglconfig,1,&config_size);
eglBindAPI(EGL_OPENGL_ES_API);
contextegl=eglCreateContext(display,eglconfig,EGL_NO_CONTEXT,anEglCtxAttribs2);
surface=eglCreateWindowSurface(display,eglconfig,0,attribut_list);
eglMakeCurrent(display,surface,surface,contextegl);
emscripten_webgl_make_context_current(ctx);
int width=S;
int height=S;

SDL_Log("GL_VERSION: %s",glGetString(GL_VERSION));
SDL_Log("GLSL_VERSION: %s",glGetString(GL_SHADING_LANGUAGE_VERSION));
std::cout<<glGetString(GL_VERSION)<<"\n";
std::cout<<glGetString(GL_SHADING_LANGUAGE_VERSION)<<"\n";

app.settings.meshX=24;
app.settings.meshY=24;
app.settings.textureSize=256;
app.settings.fps=FPS;
app.settings.windowWidth=width;
app.settings.windowHeight=width;
app.settings.smoothPresetDuration=22;
app.settings.presetDuration=44;
app.settings.beatSensitivity=1.0;
app.settings.aspectCorrection=false;
app.settings.easterEgg=0;
app.settings.shuffleEnabled=false;
app.settings.presetURL="/presets";  
app.settings.softCutRatingsEnabled=true;
app.pm=new projectM(app.settings);
printf("Init ProjectM\n");
app.pm->selectRandom(true);
printf("Select random preset.\n");
app.pm->projectM_resetGL(width,height);
printf("Reseting GL.\n");
DIR *m_dir;
if((m_dir=opendir("/"))==NULL){printf("error opening /\n");
}
else{
struct dirent *dir_entry;
while((dir_entry=readdir(m_dir))!=NULL){
printf("%s\n",dir_entry->d_name);
}}
for(uint i=0;i<app.pm->getPlaylistSize();i++){
printf("%d\t%s\n",i,app.pm->getPresetName(i).c_str());
}
glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT,GL_NICEST);
glClearColor(1.0,1.0,1.0,0.0);
emscripten_set_main_loop((void (*)())renderFrame,0,0);
}

extern "C" {
  
EM_JS(void,ma,(),{
var w$=window.innerHeight;
var h$=window.innerHeight;
var mh$=h$;
var o=[h$,h$];
var bcanvas=document.getElementById("bcanvas");
var contx=bcanvas.getContext('webgl2',{imageSmoothingEnabled:true,alpha:true,stencil:true,depth:true,preserveDrawingBuffer:false,premultipliedAlpha:false,lowLatency:true,powerPreference:'high-performance',majorVersion:2,minorVersion:0,desynchronized:false});
var vv=document.getElementById("mv");
var g=new GPU({canvas:bcanvas,webGl:contx});
var blank$=Math.max(((w$-h$)/2),0);
var nblank$=Math.max(((h$-w$)/2),0);
var t=g.createKernel(function(vv){
var P=v[this.thread.y][this.thread.x+this.constants.blnk];
var aveg=1.0-((((P[0]+P[1]+P[2])/3)-0.75)*(((P[0]+P[1]+P[2])/3)*4.0));return[P[0],P[1],P[2],(aveg)];}).setTactic("precision").setPipeline(true).setDynamicOutput(true).setConstants({blnk:blank$}).setOutput(o);
var r=g.createKernel(function(f){
var p=f[this.thread.y][this.thread.x-this.constants.nblnk];
this.color(p[0],p[1],p[2],p[3]);}).setTactic("precision").setGraphical(true).setDynamicOutput(true).setConstants({nblnk:nblank$}).setOutput(o);
var d=S();if(d)d();d=S();function S(){
$w=window.innerHeight;
$h=window.innerHeight;
blank$=Math.max(((w$-h$)/2),0);
nblank$=Math.max((h$-w$),0);
mh$=Math.min(h$,w$);
o=[h$,h$];
t.setOutput(o);
r.setOutput(o);
var l=mh$*h$*4;var m=(l/65536)+1;m=Math.floor(m);
var W1=new WebAssembly.Memory({initial:m});
var W2=new WebAssembly.Memory({initial:m});
var W3=new WebAssembly.Memory({initial:m});
var W4=new WebAssembly.Memory({initial:m});
var W5=new WebAssembly.Memory({initial:m});
var W6=new WebAssembly.Memory({initial:m});
var W7=new WebAssembly.Memory({initial:m});
var W8=new WebAssembly.Memory({initial:m});
var $1=new Uint8ClampedArray(W1.buffer,0,l);
var $2=new Uint8ClampedArray(W2.buffer,0,l);
var $3=new Uint8ClampedArray(W3.buffer,0,l);
var $4=new Uint8ClampedArray(W4.buffer,0,l);
var $5=new Uint8ClampedArray(W5.buffer,0,l);
var $6=new Uint8ClampedArray(W6.buffer,0,l);
var $7=new Uint8ClampedArray(W7.buffer,0,l);
var $8=new Uint8ClampedArray(W8.buffer,0,l);
var T=false;
vv=document.getElementById("mv");
$8.set(t(vv),0);
r(t($8));
$1.set(t(vv),0);
r(t($8));
$2.set(t(vv),0);
r(t($8));
$3.set(t(vv),0);
let $F=1;
function M(){
if(T)
{return;
}
if($F==8){
r(t($8));
$4.set(t(vv),0);
$F=1;
}
if($F==7){
r(t($7));
$3.set(t(vv),0);
$F=8;
}
if($F==6){
r(t($6));
$2.set(t(vv),0);
$F=7;
}
if($F==5){
r(t($5));
$1.set(t(vv),0);
$F=6;
}
if($F==4){
r(t($4));
$8.set(t(vv),0);
$F=5;
}
if($F==3){
r(t($3));
$7.set(t(vv),0);
$F=4;
}
if($F==2){
r(t($2));
$6.set(t(vv),0);
$F=3;
}
if($F==1){
r(t($1));
$5.set(t(vv),0);
$F=2;
}
setTimeout(function(){M();},16.6);}
M();
document.getElementById("di").onclick=function(){
T=true;
S();};return()=>{T=true;};}
});

void swtcht(){
printf("Selecting random preset.\n");
app.pm->selectRandom(true);
}

void lckt(){
app.pm->setPresetLock(true);
printf("Preset locked.\n");
}

void cls_aud(){
if(dev!=0){
SDL_PauseAudioDevice(dev,SDL_TRUE);
SDL_CloseAudioDevice(dev);
dev=0;
}}

void qu(int rc){
SDL_Quit();
exit(rc);
}

void opn_aud(){
dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);
if(!dev){
SDL_FreeWAV(wave.snd);
qu(2);
}
SDL_PauseAudioDevice(dev,SDL_FALSE);
}

void SDLCALL bfr(void *unused,Uint8* stm,int len){
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

void plt(){
static char flnm[16];
// cls_aud();
// SDL_FreeWAV(wave.snd);
// SDL_Quit();
SDL_SetMainReady();
SDL_Init(SDL_INIT_AUDIO);
SDL_strlcpy(flnm,"/snd/sample.wav",sizeof(flnm));
if(SDL_LoadWAV(flnm,&wave.spec,&wave.snd,&wave.slen)==NULL){
qu(1);
}
wave.pos=0;
wave.spec.callback=bfr;
opn_aud();
}

void pl(){
plt();
}
void chng(){
chngt();
}
void lck(){
lckt();
}
void swtch(){
swtcht();
}
void b3(){
// ma();
}

}

int main(){
EM_ASM({
FS.mkdir('/snd');
FS.mkdir('/textures');
FS.mkdir('/presets');
});
app.done=0;
return PROJECTM_SUCCESS;
}
