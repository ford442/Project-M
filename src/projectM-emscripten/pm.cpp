#include <emscripten.h>
#include <emscripten/html5.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES3/gl31.h>
#include <GLES3/gl32.h>
#define __gl2_h_
#include <GLES2/gl2ext.h>
#include <SDL2/SDL.h>
#include <projectM.hpp>
#include <algorithm>
#include <iostream>
#include <cstring>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <cstdarg>
#include <cstdbool>
#include <unistd.h>
#include <chrono>

using namespace std;
using namespace std::chrono;
struct timespec rem;
struct timespec req={0,1500000000};
EmscriptenWebGLContextAttributes attr;

#define FLAG_DISABLE_PLAYLIST_LOAD 1

Uint8 *stm;
EGLDisplay display;
EGLContext contextegl;
EGLSurface surface;
const float FPS=60.0f;
SDL_AudioDeviceID dev;
struct{SDL_AudioSpec spec;Uint8 *snd;Uint32 slen;int pos;}wave;
typedef struct{projectM *pm;bool done;projectM::Settings settings;SDL_AudioDeviceID dev;}projectMApp;projectMApp app;
EGLint config_size,major,minor;
static char flnm[16];
static EGLint v0=0,v1=1,v2=2,v3=3,v8=8,v24=24,v32=32;
  
void renderFrame(){
glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);
app.pm->renderFrame();
auto sndat=reinterpret_cast<short*>(stm);
app.pm->pcm()->addPCM16Data(sndat,1024/sizeof(short));
eglSwapBuffers(display,surface);
}

static const EGLint attribut_list[]={
  // EGL_GL_COLORSPACE_KHR,EGL_GL_COLORSPACE_SRGB_KHR,
EGL_NONE
};

static const EGLint attribute_list[]={
// EGL_COLOR_COMPONENT_TYPE_EXT,EGL_COLOR_COMPONENT_TYPE_FLOAT_EXT,
EGL_CONTEXT_OPENGL_PROFILE_MASK_KHR,EGL_CONTEXT_OPENGL_COMPATIBILITY_PROFILE_BIT_KHR,
EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,
EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT,EGL_TRUE,
EGL_DEPTH_ENCODING_NV,EGL_DEPTH_ENCODING_NONLINEAR_NV,
EGL_RENDER_BUFFER,EGL_QUADRUPLE_BUFFER_NV,
// EGL_CONTEXT_OPENGL_FORWARD_COMPATIBLE,EGL_TRUE,
EGL_RED_SIZE,v8,
EGL_GREEN_SIZE,v8,
EGL_BLUE_SIZE,v8,
EGL_ALPHA_SIZE,v8,
EGL_DEPTH_SIZE,v24,
EGL_STENCIL_SIZE,v8,
EGL_BUFFER_SIZE,v32,
EGL_NONE
};

static EGLint anEglCtxAttribs2[]={
EGL_CONTEXT_CLIENT_VERSION,v3,
EGL_CONTEXT_PRIORITY_LEVEL_IMG,EGL_CONTEXT_PRIORITY_REALTIME_NV,
// EGL_COLOR_COMPONENT_TYPE_EXT,EGL_COLOR_COMPONENT_TYPE_FLOAT_EXT,
EGL_NONE};

void chngt(){
emscripten_webgl_init_context_attributes(&attr);
attr.alpha=EM_TRUE;
attr.stencil=EM_TRUE;
attr.depth=EM_TRUE;
attr.antialias=EM_FALSE;
attr.premultipliedAlpha=EM_FALSE;
attr.preserveDrawingBuffer=EM_FALSE;
attr.enableExtensionsByDefault=EM_FALSE;
attr.powerPreference=EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
attr.failIfMajorPerformanceCaveat=EM_FALSE;
attr.majorVersion=v2;
attr.minorVersion=v0;
int S=EM_ASM_INT({return parseInt(document.getElementById('pmhig').innerHTML,10);});
static EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx=emscripten_webgl_create_context("#pcanvas",&attr);
EGLConfig eglconfig=NULL;
display=eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(display,&v3,&v0);
eglChooseConfig(display,attribute_list,&eglconfig,1,&config_size);
eglBindAPI(EGL_OPENGL_ES_API);
contextegl=eglCreateContext(display,eglconfig,EGL_NO_CONTEXT,anEglCtxAttribs2);
surface=eglCreateWindowSurface(display,eglconfig,0,attribut_list);
eglMakeCurrent(display,surface,surface,contextegl);
emscripten_webgl_make_context_current(ctx);
int width=(int)S;
int height=(int)S;
std::cout<<glGetString(GL_VERSION)<<"\n";
std::cout<<glGetString(GL_SHADING_LANGUAGE_VERSION)<<"\n";
app.settings.meshX=32;
app.settings.meshY=32;
app.settings.textureSize=256;
app.settings.fps=FPS;
app.settings.windowWidth=width;
app.settings.windowHeight=width;
app.settings.smoothPresetDuration=22;
app.settings.presetDuration=44;
app.settings.beatSensitivity=1;
app.settings.aspectCorrection=false;
app.settings.easterEgg=0;
app.settings.shuffleEnabled=false;
app.settings.presetURL="/presets";  
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
//  glHint(GL_FRAGMENT_SHADER_DERIVATIVE_HINT,GL_NICEST);
  
emscripten_set_main_loop((void (*)())renderFrame,0,0);
}
static void swtcht(){
printf("Selecting random preset.\n");
app.pm->selectRandom(true);
}
static void lckt(){
app.pm->setPresetLock(true);
printf("Preset locked.\n");
}
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
void opn_aud(){
dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);
if(!dev){
SDL_FreeWAV(wave.snd);
qu(2);
}
SDL_PauseAudioDevice(dev,SDL_FALSE);
}
void SDLCALL bfr(void *unused,Uint8 *stm,int len){
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

EM_JS(void,ma,(),{
let w$=document.getElementById('iwid').innerHTML;
let h$=document.getElementById('ihig').innerHTML;
var mh$=Math.min(h$,w$);
let o=[h$,h$];
const bcanvas=document.getElementById("bcanvas");
const contx=bcanvas.getContext('webgl2',{alpha:true,stencil:false,depth:false,preserveDrawingBuffer:false,premultipliedAlpha:false,lowLatency:true,powerPreference:'high-performance',majorVersion:2,minorVersion:0,desynchronized:false});
let v=document.getElementById("mv");
const g=new GPU({canvas:bcanvas,webGl:contx});
var blank$=Math.max(((w$-h$)/2),0);
var nblank$=Math.max(((h$-w$)/2),0);
var t=g.createKernel(function(v){
const P=v[this.thread.y][this.thread.x+this.constants.blnk];
let aveg=1.0-((((P[0]+P[1]+P[2])/3)-0.75)*(((P[0]+P[1]+P[2])/3)*4.0));return[P[0],P[1],P[2],(aveg)];}).setTactic("precision").setPipeline(true).setDynamicOutput(true).setConstants({blnk:blank$}).setOutput(o);
var r=g.createKernel(function(f){
const p=f[this.thread.y][this.thread.x-this.constants.nblnk];
this.color(p[0],p[1],p[2],p[3]);}).setTactic("precision").setGraphical(true).setDynamicOutput(true).setConstants({nblnk:nblank$}).setOutput(o);
let d=S();if(d)d();d=S();function S(){
$w=document.getElementById('iwid').innerHTML;
$h=document.getElementById('pmhig').innerHTML;
blank$=Math.max(((w$-h$)/2),0);
nblank$=Math.max((h$-w$),0);
mh$=Math.min(h$,w$);
o=[h$,h$];
t.setOutput(o);
r.setOutput(o);
var l=mh$*h$*4;var m=(l/65536)+1;m=Math.floor(m);
let W1=new WebAssembly.Memory({initial:m});
let W2=new WebAssembly.Memory({initial:m});
let W3=new WebAssembly.Memory({initial:m});
let W4=new WebAssembly.Memory({initial:m});
let W5=new WebAssembly.Memory({initial:m});
let W6=new WebAssembly.Memory({initial:m});
let W7=new WebAssembly.Memory({initial:m});
let W8=new WebAssembly.Memory({initial:m});
let $1=new Uint8ClampedArray(W1.buffer,0,l);
let $2=new Uint8ClampedArray(W2.buffer,0,l);
let $3=new Uint8ClampedArray(W3.buffer,0,l);
let $4=new Uint8ClampedArray(W4.buffer,0,l);
let $5=new Uint8ClampedArray(W5.buffer,0,l);
let $6=new Uint8ClampedArray(W6.buffer,0,l);
let $7=new Uint8ClampedArray(W7.buffer,0,l);
let $8=new Uint8ClampedArray(W8.buffer,0,l);
let T=false;
let vv=document.getElementById("mv");

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
setTimeout(function(){M();},16.666);}
M();
document.getElementById("di").onclick=function(){
T=true;
S();};return()=>{T=true;};}
});

extern "C" {
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
ma();
}}

int main(){
EM_ASM({
FS.mkdir('/snd');
FS.mkdir('/textures');
FS.mkdir('/presets');
});
app.done=0;
ma();
return 1;
}
