#include <string>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#include <GLES3/gl3.h>
#include <EGL/egl.h>
#include "SDL2/SDL_config.h"
#include <SDL2/SDL.h>
#include <projectM.hpp>

static EGLint attribute_list[]={
EGL_RED_SIZE,32,
EGL_GREEN_SIZE,32,
EGL_BLUE_SIZE,32,
EGL_ALPHA_SIZE,32,
EGL_ALPHA_MASK_SIZE,128,
EGL_DEPTH_SIZE,128,
EGL_STENCIL_SIZE,128,
EGL_CONFORMANT,EGL_OPENGL_ES3_BIT,
EGL_TRANSPARENT_TYPE,EGL_TRANSPARENT_RGB,
EGL_NONE
};

const float FPS=60;
static SDL_AudioDeviceID dev;
static struct{SDL_AudioSpec spec;Uint8 *snd;Uint32 slen;int pos;}wave;
typedef struct{projectM *pm;SDL_Window *win;SDL_GLContext *glCtx;bool done;projectM::Settings settings;SDL_AudioDeviceID dev;}
projectMApp;projectMApp app;
static void renderFrame(){
auto sndBuf=wave.snd+wave.pos;
auto sndat=reinterpret_cast<short*>(sndBuf);
app.pm->pcm()->addPCM16Data(sndat,1024);
glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
app.pm->renderFrame();
// glFlush();
SDL_GL_SwapWindow(app.win);
}
void swtcht(){
app.pm->selectRandom(true);
printf("Select random preset.\n");
}
void lckt(){
app.pm->setPresetLock(true);
printf("Preset locked.\n");
}
static void chngt(){
EmscriptenWebGLContextAttributes attr;
attr.alpha = 1;
attr.stencil = 1;
attr.depth = 1;
attr.antialias = 0;
attr.premultipliedAlpha = 0;
attr.preserveDrawingBuffer = 0;
emscripten_webgl_init_context_attributes(&attr);
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx=emscripten_webgl_create_context("#canvas",&attr);
emscripten_webgl_make_context_current(ctx);
EGLConfig eglconfig=NULL;
EGLint config_size,major,minor;
EGLContext contextegl;
EGLDisplay display=eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(display,&major,&minor);
if(eglChooseConfig(display,attribute_list,&eglconfig,1,&config_size)==EGL_TRUE && eglconfig!=NULL){
if(eglBindAPI(EGL_OPENGL_ES_API)!=EGL_TRUE){
}
EGLint anEglCtxAttribs2[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE,EGL_NONE};
contextegl=eglCreateContext (display,eglconfig,EGL_NO_CONTEXT,anEglCtxAttribs2);
if(contextegl==EGL_NO_CONTEXT){
}else{
EGLSurface surface=eglCreateWindowSurface(display,eglconfig,NULL,NULL);
eglMakeCurrent(display,surface,surface,contextegl);
}}
int width=EM_ASM_INT({return document.getElementById('ihig').innerHTML;});
int height=width;
app.win=SDL_CreateWindow("pm",SDL_WINDOWPOS_UNDEFINED,SDL_WINDOWPOS_UNDEFINED,width,height,SDL_WINDOW_OPENGL);
app.glCtx=&contextegl;
SDL_SetWindowTitle(app.win,"1inkDrop - [from 1ink.us]");
SDL_Log("GL_VERSION: %s",glGetString(GL_VERSION));
SDL_Log("GL_SHADING_LANGUAGE_VERSION: %s",glGetString(GL_SHADING_LANGUAGE_VERSION));
app.settings.meshX=64;
app.settings.meshY=64;
app.settings.textureSize=2048;
app.settings.fps=FPS;
app.settings.textureSize=EM_ASM_INT({return Math.pow(2,Math.floor(Math.log(window.innerHeight)/Math.log(2)));});
app.settings.windowWidth=width;
app.settings.windowHeight=width;
app.settings.smoothPresetDuration=22;
app.settings.presetDuration=88;
app.settings.beatSensitivity=1;
app.settings.aspectCorrection=0;
app.settings.easterEgg=0;
app.settings.shuffleEnabled=0;
app.settings.softCutRatingsEnabled=0;
app.settings.presetURL="/presets";
app.pm=new projectM(app.settings);
printf("Init ProjectM\n");
app.pm->selectRandom(true);
printf("Select random preset.\n");
app.pm->projectM_resetGL(width,height);
printf("Reseting GL.\n");
DIR *m_dir;
if((m_dir=opendir("/"))==NULL){printf("error opening /\n");
}else{
struct dirent *dir_entry;
while((dir_entry=readdir(m_dir))!=NULL){
printf("%s\n",dir_entry->d_name);
}}
for(uint i=0;i<app.pm->getPlaylistSize();i++){
printf("%d\t%s\n",i,app.pm->getPresetName(i).c_str());
}
glClearColor(0,0,0,0);
emscripten_set_main_loop((void (*)())renderFrame,0,0);
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
static void opn_aud(){
dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);
if(!dev){
SDL_FreeWAV(wave.snd);
qu(2);
}
SDL_PauseAudioDevice(dev,SDL_FALSE);
}
static void SDLCALL bfr(void *unused,Uint8 * stm,int len){
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
static void plt(){
cls_aud();
char flnm[1024];
SDL_FreeWAV(wave.snd);
SDL_Quit();
SDL_SetMainReady();
if (SDL_Init(SDL_INIT_AUDIO)<0){
qu(1);
}
SDL_strlcpy(flnm,"/sample.wav",sizeof(flnm));
if(SDL_LoadWAV(flnm,&wave.spec,&wave.snd,&wave.slen)==NULL){
qu(1);
}
wave.pos=0;
wave.spec.callback=bfr;
opn_aud();
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
}}
int main(){
EM_ASM({
FS.mkdir('/presets');
document.getElementById("circle").width=window.innerWidth;
document.getElementById("circle").height=window.innerHeight;
document.getElementById("contain2").width=window.innerHeight;
document.getElementById("contain2").height=window.innerHeight;
document.getElementById('btn3').addEventListener('click',function(){
window.open('https://test.1ink.us/libflac.js/');
});});
app.done=0;
return 1;
}
