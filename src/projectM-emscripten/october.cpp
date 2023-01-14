#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

void avgFrm(int Fnum,int leng,float *ptr,float *aptr);

void avgFrm(int Fnum,int leng,float *ptr,float *aptr){
float max=0.0;
float min=1.0;
float sum=0.0;
float avgSum=0.0;
float minSum=0.0;
float maxSum=0.0;
for (int i=0;i<leng;i++){
sum+=ptr[i];
if(max<ptr[i]){max=ptr[i];}
if(min>ptr[i]&&ptr[i]>0){min=ptr[i];}
}
sum=sum/leng;
aptr[Fnum]=sum;
aptr[Fnum+100]=min;
aptr[Fnum+200]=max;
for(int i=33;i<65;i++){
avgSum+=aptr[i];
}
aptr[0]=avgSum/32;
for(int i=33;i<65;i++){
minSum+=aptr[i+100];
}
aptr[100]=minSum/32;
for(int i=33;i<65;i++){
maxSum+=aptr[i+200];
}
aptr[200]=maxSum/32;
return;
}

extern "C" {

void nano(int Fnum,int leng,float *ptr,float *aptr){
avgFrm(Fnum,leng,ptr,aptr);
}

}

extern "C" {

EM_JS(void,ma,(),{

const pnnl=document.body;
var vv=document.getElementById("mv");
let intervalBackward;

function back(){
intervalBackward=setInterval(function(){
if(vv.currentTime==0){
clearInterval(intervalBackward);
}else{
vv.currentTime+=-(0.016);
}
},16.66);
};

let intervalForward;

function forward(){
intervalForward=setInterval(function(){
vv.currentTime+=-(0.016);
},16.66);
};

let intervalLoop;
var stp,a,b,f;

function backForth(stp){
var a=(stp/1000.0);
var b=(stp/1000.0)+1.0;
f=true;
intervalLoop=setInterval(function(){
if(f==true){
if(vv.currentTime>a){
vv.currentTime+=-(0.016666);
}else{
f=false;
}}else if(vv.currentTime<b){
vv.currentTime+=(0.016666);
}else{
f=true;
}
},16.66);
};

function stpForward(){
clearInterval(intervalForward);
}

function stpBack(){
clearInterval(intervalBackward);
}

function stpBackForth(){
clearInterval(intervalLoop);
}

var Mov=1;

function doKey(e){
if(e.code=='Space'){
e.preventDefault();
if(Mov==1){vv=document.getElementById("mv");Mov=0;vv.pause();}
else if(Mov==0){vv=document.getElementById("mv");Mov=1;vv.play();}
}
if (e.code=='KeyW'){vv=document.getElementById("mv");Mov=1;vv.pause();forward();}
if (e.code=='KeyS'){vv=document.getElementById("mv");Mov=1;vv.pause();back();}
if (e.code=='KeyZ'){vv=document.getElementById("mv");Mov=1;vv.pause();var stp=vv.currentTime*1000.0;
backForth(stp);}
if (e.code=='KeyX'){vv=document.getElementById("mv");stpBackForth();vv.play();}
}

function doKeyUp(e){
if (e.code=='KeyS'){Mov=0;stpBack();vv.pause();}
if (e.code=='KeyW'){Mov=0;stpForward();vv.pause();}
}

pnnl.addEventListener('keydown',doKey);
pnnl.addEventListener('keydown',doKeyUp);
let w$=parseInt(document.getElementById("wid").innerHTML,10);
let h$=parseInt(document.getElementById("hig").innerHTML,10);
vv=document.getElementById("mv");
let $H=Module.HEAPF32.buffer;
let la=h$*h$*4;
var pointa=77*la;
let agav=new Float32Array($H,pointa,300);
let sz=(h$*h$)/8;
var avag=0.750;
var min=1.0;
var max=0.0;
agav.fill(avag,0,33);
agav.fill(min,100,33);
agav.fill(max,200,33);
const bcanvas=document.getElementById("bcanvas");
const contx=bcanvas.getContext("webgl2",{logarithmicDepthBuffer:true,colorSpace:'display-p3',alpha:true,depth:true,stencil:true,imageSmoothingEnabled:true,preserveDrawingBuffer:false,premultipliedAlpha:false,desynchronized:false,lowLatency:true,powerPreference:'high-performance',antialias:true,willReadFrequently:true});
contx.getExtension('EXT_color_buffer_float');
contx.getExtension('OES_texture_float_linear');
const g=new GPU({canvas:bcanvas,webGl:contx});
const g2=new GPU();
const glslAve=`float Ave(float a,float b,float c) {return (a+b+c)/3.0;}`;
const glslAlphe=`float Alphe(float a,float b,float c,float d,float e,float f,float g){return ((0.7+(3.0*((1.0-b)-(((((1.0-f)-(a)+b)*1.5)/2.0)+((f-0.5)*((1.0-f)*0.25))-((0.5-f)*(f*0.25))-((g-e)*((1.0-g)*0.1))))))/4.0);}`;
const glslAveg=`float Aveg(float a,float b) {return (0.9999522-(((a)-(b))*((a)*(0.9999522/(0.9999522-b))))) ;}`;
g.addNativeFunction('Ave', glslAve, { returnType: 'Number' });
g.addNativeFunction('Alphe', glslAlphe, { returnType: 'Number' });
g.addNativeFunction('Aveg', glslAveg, { returnType: 'Number' });
g2.addNativeFunction('Aveg', glslAveg, { returnType: 'Number' });
g2.addNativeFunction('Ave', glslAve, { returnType: 'Number' });
const R=g2.createKernel(function(tv){
var Pa=tv[this.thread.y][this.thread.x*4];
return Ave(Pa[0],Pa[1],Pa[2]);
}).setTactic("speed").setDynamicOutput(true).setArgumentTypes(["HTMLVideo"]).setOutput([sz]);
const t=g.createKernel(function(v){
var P=v[this.thread.y][this.thread.x-this.constants.blnk-this.constants.nblnk];
var av$=Ave(P[0],P[1],P[2]);
return[P[0],P[1],P[2],av$];
}).setTactic("precision").setPrecision('single').setPipeline(true).setArgumentTypes(["HTMLVideo"]).setDynamicOutput(true).setOutput([w$,h$]);
const r=g.createKernel(function(f){
var p=f[this.thread.y][this.thread.x-this.constants.nblnk-this.constants.blnk];
var $fmax=this.constants.fmax;
var $fmin=this.constants.fmin;
var $amax=this.constants.amax;
var $amin=this.constants.amin;
var $favg=this.constants.favg;
var $aavg=this.constants.aavg;
var alph=Alphe($amax,$amin,$fmax,$fmin,$favg,$aavg,p[3]);
var Min=(4.0*(($fmax-($aavg-$fmin))/2.0));
var ouT=Math.max(Min,alph);
var aveg=Aveg(p[3],ouT);
this.color(p[0],p[1],p[2],aveg);
}).setTactic("precision").setGraphical(true).setArgumentTypes(['HTMLVideo']).setDynamicOutput(true).setOutput([w$,h$]);
w$=parseInt(document.getElementById("wid").innerHTML,10);
h$=parseInt(document.getElementById("hig").innerHTML,10);
vv=document.getElementById("mv");
var blank$=Math.max((((w$-h$)*0)/2),0);
var nblank$=Math.max((((h$-w$)*0)/2),0);
let l=w$*h$*16;
la=h$*h$*4;
let al=w$*h$*8;
sz=(h$*h$)/8;
pointa=77*la;
agav=new Float32Array($H,pointa,300);
R.setOutput([sz]);
for(i=0;i<65;i++){
var j=i+1;
eval("var point"+j+"="+i+"*la;var $"+j+"=new Float32Array($H,point"+j+",la);");
}
var pointb=77*la;
var $B=new Float32Array($H,pointb,sz);
var $F=1;
var $Bu=33;
r.setConstants({nblnk:nblank$,blnk:blank$,favg:agav[$F],fmin:agav[$F+100],fmax:agav[$F+200],amin:agav[100],amax:agav[200],aavg:agav[0]});
t.setConstants({nblnk:nblank$,blnk:blank$});
var $$1=t(vv);
for (i=0;i<65;i++){
var j=i+1;
eval("$"+j+".set($$1);");
}
var d=S();if(d)d();d=S();function S(){
w$=parseInt(document.getElementById("wid").innerHTML,10);
h$=parseInt(document.getElementById("hig").innerHTML,10);
var blank$=Math.max((((w$-h$)*0)/2),0);
var nblank$=Math.max((((h$-w$)*0)/2),0);
l=w$*h$*16;
la=h$*h$*4;
al=w$*h$*8;
sz=(h$*h$)/8;
pointa=77*la;
var agav=new Float32Array($H,pointa,300);
R.setOutput([sz]);
for(i=0;i<65;i++){
var j=i+1;
eval("var point"+j+"="+i+"*la;var $"+j+"=new Float32Array($H,point"+j+",la);");
}
pointb=66*la;
var $B=new Float32Array($H,pointb,sz);
r.setConstants({nblnk:nblank$,blnk:blank$,favg:agav[$F],fmin:agav[$F+100],fmax:agav[$F+200],amin:agav[100],amax:agav[200],aavg:agav[0]});
t.setConstants({nblnk:nblank$,blnk:blank$});
var T=false;
function M(){
vv=document.getElementById("mv");
t.setConstants({nblnk:nblank$,blnk:blank$});
r.setConstants({nblnk:nblank$,blnk:blank$,favg:agav[$F],fmin:agav[$F+100],fmax:agav[$F+200],amin:agav[100],amax:agav[200],aavg:agav[0]});
if(T){return;}
for(i=64;i>0;i--){
var loca=$F+1;if(loca>64){loca=1;}
var locb=$Bu+1;if(locb>64){locb=1;}
eval("if ($F==="+i+"){var $r"+i+"=t($"+i+");r($r"+i+");var $$"+$Bu+"=t(vv);$"+$Bu+".set($$"+$Bu+");$F="+loca+";$Bu="+locb+";}");
}
var $bb=R(vv);
$B.set($bb,0,sz);
pointb=66*la;
Module.ccall("nano",null,["Number","Number","Number","Number"],[$F,sz,pointb,pointa]);
setTimeout(function(){
M();
},16.66);
}
M();
document.getElementById("di").onclick=function(){
T=true;
S();
};
return()=>{
T=true;
};
}
})

}

#define GL_FRAGMENT_PRECISION_HIGH 1
#define GL3_PROTOTYPES 1

#include <GL/gl.h>
#include <GL/glext.h>
#include <GLES3/gl3.h>
#include <GLES3/gl31.h>
#include <GLES3/gl32.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>

#include <SDL2/SDL.h>
#include <string>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

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

struct timespec rem;
struct timespec req={0,1200000000};

#define FLAG_DISABLE_PLAYLIST_LOAD 1

typedef struct{projectM *pm;bool done;projectM::Settings settings;SDL_AudioDeviceID dev;}projectMApp;
projectMApp app;

int v0=0,v1=1,v2=2,v3=3,v4=4,v6=6,v8=8,v10=10,v16=16,v24=24,v32=32;

SDL_AudioDeviceID dev;

struct{Uint8 * snd;int pos;Uint32 slen;SDL_AudioSpec request;Uint8 * stm;}wave;

void renderFrame(){
glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);
app.pm->renderFrame();
// glFlush();
auto sndat=reinterpret_cast<short*>(wave.stm);
app.pm->pcm()->addPCM16Data(sndat,1024/sizeof(short));
// glFinish();
}

void chngt(){
const float FPS=60;
EmscriptenWebGLContextAttributes attr;
EGLDisplay display;
EGLContext contextegl;
EGLSurface surface;
EGLint config_size,major,minor;
static EGLint anEglCtxAttribs2[]={
EGL_CONTEXT_CLIENT_VERSION,(EGLint)4,
EGL_CONTEXT_MINOR_VERSION_KHR,(EGLint)6,
EGL_CONTEXT_PRIORITY_LEVEL_IMG,EGL_CONTEXT_PRIORITY_REALTIME_NV,
EGL_COLOR_COMPONENT_TYPE_EXT,EGL_COLOR_COMPONENT_TYPE_FLOAT_EXT,
EGL_CONTEXT_FLAGS_KHR,EGL_CONTEXT_OPENGL_FORWARD_COMPATIBLE_BIT_KHR,
EGL_CONTEXT_FLAGS_KHR,EGL_CONTEXT_OPENGL_ROBUST_ACCESS_BIT_KHR,
EGL_NONE};
  
const EGLint attribut_list[]={
// EGL_GL_COLORSPACE_KHR,EGL_GL_COLORSPACE_SRGB_KHR,
EGL_NONE
};

const EGLint attribute_list[]={
EGL_COLOR_COMPONENT_TYPE_EXT,EGL_COLOR_COMPONENT_TYPE_FLOAT_EXT,
// EGL_CONTEXT_OPENGL_PROFILE_MASK_KHR,EGL_CONTEXT_OPENGL_COMPATIBILITY_PROFILE_BIT_KHR,
EGL_CONTEXT_OPENGL_PROFILE_MASK_KHR,EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT_KHR,
// EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,
EGL_RENDERABLE_TYPE,EGL_OPENGL_BIT,
EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT,EGL_TRUE,
EGL_DEPTH_ENCODING_NV,EGL_DEPTH_ENCODING_NONLINEAR_NV,
EGL_RENDER_BUFFER,EGL_QUADRUPLE_BUFFER_NV,
EGL_CONTEXT_OPENGL_FORWARD_COMPATIBLE,EGL_TRUE,
EGL_RED_SIZE,8,
EGL_GREEN_SIZE,8,
EGL_BLUE_SIZE,8,
EGL_ALPHA_SIZE,8,
EGL_DEPTH_SIZE,32,
EGL_STENCIL_SIZE,8,
EGL_BUFFER_SIZE,32,
EGL_SAMPLE_BUFFERS,64,
EGL_SAMPLES,32,
EGL_NONE
};
  
attr.alpha=EM_TRUE;
attr.stencil=EM_TRUE;
attr.depth=EM_TRUE;
attr.antialias=EM_TRUE;
attr.premultipliedAlpha=EM_FALSE;
attr.preserveDrawingBuffer=EM_FALSE;
attr.enableExtensionsByDefault=EM_FALSE;
attr.powerPreference=EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
attr.failIfMajorPerformanceCaveat=EM_FALSE;
attr.majorVersion=v2;
attr.minorVersion=v0;
emscripten_webgl_init_context_attributes(&attr);
  
// int S=EM_ASM_INT({return parseInt(window.innerHeight);});
// Size=EM_ASM_INT({return parseInt(window.innerHeight);});
double wi,hi;
emscripten_get_element_css_size("pcanvas",&wi,&hi);
int Size=(int)hi;
int S=(GLfloat)Size;
// eglBindAPI(EGL_OPENGL_ES_API);

EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx=emscripten_webgl_create_context("#pcanvas",&attr);
EGLConfig eglconfig=NULL;
eglBindAPI(EGL_OPENGL_API);
display=eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(display,&major,&minor);
eglChooseConfig(display,attribute_list,&eglconfig,(EGLint)1,&config_size);
contextegl=eglCreateContext(display,eglconfig,EGL_NO_CONTEXT,anEglCtxAttribs2);
surface=eglCreateWindowSurface(display,eglconfig,(NativeWindowType)0,attribut_list);
eglMakeCurrent(display,surface,surface,contextegl);
emscripten_webgl_make_context_current(ctx);
int width=Size;
int height=Size;

SDL_Log("GL_VERSION: %s",glGetString(GL_VERSION));
SDL_Log("GLSL_VERSION: %s",glGetString(GL_SHADING_LANGUAGE_VERSION));
std::cout<<glGetString(GL_VERSION)<<"\n";
std::cout<<glGetString(GL_SHADING_LANGUAGE_VERSION)<<"\n";

app.settings.meshX=24;
app.settings.meshY=24;
app.settings.textureSize=128;
app.settings.fps=FPS;
app.settings.windowWidth=width;
app.settings.windowHeight=width;
app.settings.smoothPresetDuration=22;
app.settings.presetDuration=23;
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
glClearColor(1.0,1.0,1.0,1.0);
emscripten_set_main_loop((void (*)())renderFrame,0,0);
}




void swtcht(){
printf("Selecting random preset.\n");
app.pm->selectRandom(true);
}

void lckt(){
app.pm->setPresetLock(true);
printf("Preset locked.\n");
}

void SDLCALL bfr(void * unused,Uint8 * stm,int len){
Uint8 * wptr;
int lft;
wptr=wave.snd+wave.pos;
lft=wave.slen-wave.pos;
while (lft<=len){
SDL_UnlockAudioDevice(dev);
SDL_memcpy(wave.stm,wptr,lft);
wave.stm+=lft;
len-=lft;
wptr=wave.snd;
lft=wave.slen;
wave.pos=0;
SDL_LockAudioDevice(dev);
}
SDL_memcpy(wave.stm,wptr,len);
wave.pos+=len;
return;
}

void plt(){
char flnm[24];
SDL_memset(&wave.request,0,sizeof(wave.request));
wave.request.freq=44100;
wave.request.format=AUDIO_S32;
wave.request.channels=2;
wave.request.samples=1024;
wave.pos=0;
SDL_strlcpy(flnm,"/snd/sample.wav",sizeof(flnm));
SDL_Init(SDL_INIT_AUDIO);
SDL_LoadWAV(flnm,&wave.request,&wave.snd,&wave.slen);
wave.request.callback=bfr;
dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.request,NULL,0);
SDL_PauseAudioDevice(dev,SDL_FALSE);
return;
}

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
