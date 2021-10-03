#include <string>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <GLES3/gl32.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#include "SDL2/SDL_config.h"
#include <SDL2/SDL.h>
#include <projectM.hpp>

Uint8* stm;

static const EGLint attribut_list[]={
EGL_GL_COLORSPACE,EGL_GL_COLORSPACE_SRGB,
EGL_NONE
};

static const EGLint attribute_list[]={
EGL_RED_SIZE,16,
EGL_GREEN_SIZE,16,
EGL_BLUE_SIZE,16,
EGL_ALPHA_SIZE,16,
EGL_STENCIL_SIZE,16,
EGL_DEPTH_SIZE,32,
EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,
EGL_CONFORMANT,EGL_OPENGL_ES3_BIT,
EGL_NONE
};

EGLSurface surface;
EGLDisplay display;
EGLContext contextegl;
const float FPS=60;
static SDL_AudioDeviceID dev;
static struct{SDL_AudioSpec spec;Uint8 *snd;Uint32 slen;int pos;}wave;
typedef struct{projectM *pm;SDL_Window *win;SDL_GLContext *glCtx;bool done;projectM::Settings settings;SDL_AudioDeviceID dev;}
projectMApp;projectMApp app;

static void renderFrame(){
auto sndat=reinterpret_cast<short*>(stm);
glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT|GL_STENCIL_BUFFER_BIT);
app.pm->pcm()->addPCM16Data(sndat,512);
app.pm->renderFrame();
eglSwapBuffers(display,surface);
}

static void chngt(){
SDL_GL_SetAttribute(SDL_GL_RED_SIZE,16);
SDL_GL_SetAttribute(SDL_GL_GREEN_SIZE,16);
SDL_GL_SetAttribute(SDL_GL_BLUE_SIZE,16);
SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE,32);
SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER,1);
SDL_GL_SetAttribute(SDL_GL_ALPHA_SIZE,16);
SDL_GL_SetAttribute(SDL_GL_BUFFER_SIZE,32);
SDL_GL_SetAttribute(SDL_GL_STENCIL_SIZE,16);
SDL_GL_SetAttribute(SDL_GL_ACCUM_RED_SIZE,16);
SDL_GL_SetAttribute(SDL_GL_ACCUM_GREEN_SIZE,16);
SDL_GL_SetAttribute(SDL_GL_ACCUM_BLUE_SIZE,16);
SDL_GL_SetAttribute(SDL_GL_ACCUM_ALPHA_SIZE,16);
  
EmscriptenWebGLContextAttributes attr;
attr.alpha=1;
attr.stencil=1;
attr.depth=1;
attr.antialias=0;
attr.premultipliedAlpha=0;
attr.preserveDrawingBuffer=0;
emscripten_webgl_init_context_attributes(&attr);
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx=emscripten_webgl_create_context("#canvas",&attr);
  
int width=EM_ASM_INT({return document.getElementById('ihig').innerHTML;});
int height=width;
app.win=SDL_CreateWindow("pm",SDL_WINDOWPOS_UNDEFINED,SDL_WINDOWPOS_UNDEFINED,width,height,SDL_WINDOW_OPENGL|SDL_WINDOW_BORDERLESS|SDL_WINDOW_ALLOW_HIGHDPI);
  
emscripten_webgl_make_context_current(ctx);
EGLConfig eglconfig=NULL;
EGLint config_size,major,minor;
EGLDisplay display=eglGetDisplay(EGL_DEFAULT_DISPLAY);
eglInitialize(display,&major,&minor);
  
if(eglChooseConfig(display,attribute_list,&eglconfig,1,&config_size)==EGL_TRUE && eglconfig!=NULL){
if(eglBindAPI(EGL_OPENGL_ES_API)!=EGL_TRUE){
}

EGLint anEglCtxAttribs2[]={
EGL_CONTEXT_CLIENT_VERSION,3,
EGL_CONTEXT_OPENGL_ROBUST_ACCESS,EGL_TRUE,
EGL_CONTEXT_OPENGL_PROFILE_MASK,EGL_CONTEXT_OPENGL_COMPATIBILITY_PROFILE_BIT,
EGL_CONTEXT_OPENGL_FORWARD_COMPATIBLE,EGL_TRUE,
EGL_CONTEXT_MINOR_VERSION,2,
EGL_NONE
};
  
contextegl=eglCreateContext(display,eglconfig,EGL_NO_CONTEXT,anEglCtxAttribs2);
EGLSurface surface=eglCreateWindowSurface(display,eglconfig,NULL,attribut_list);
eglMakeCurrent(display,surface,surface,contextegl);
}
  
app.glCtx=&contextegl;
SDL_SetWindowTitle(app.win,"1ink.us - Lazuli");
SDL_Log("GL_VERSION: %s",glGetString(GL_VERSION));
SDL_Log("GLSL_VERSION: %s",glGetString(GL_SHADING_LANGUAGE_VERSION));
app.settings.meshX=96;
app.settings.meshY=96;
app.settings.textureSize=2048;
app.settings.fps=FPS;
app.settings.windowWidth=width;
app.settings.windowHeight=width;
app.settings.smoothPresetDuration=22;
app.settings.presetDuration=88;
app.settings.beatSensitivity=1.0;
app.settings.aspectCorrection=0;
app.settings.easterEgg=0;
app.settings.shuffleEnabled=0;
app.settings.softCutRatingsEnabled=1;
app.settings.presetURL="/presets";
app.pm=new projectM(app.settings);
app.pm->projectM_resetGL(width,height);
printf("Reseting GL.\n");
printf("Init ProjectM\n");
app.pm->selectRandom(true);
printf("Select random preset.\n");
  
DIR *m_dir;
if((m_dir=opendir("/"))==NULL){
printf("error opening /\n");
}
else{
struct dirent *dir_entry;
while((dir_entry=readdir(m_dir))!=NULL){
printf("%s\n",dir_entry->d_name);
}}
for(uint i=0;i<app.pm->getPlaylistSize();i++){
printf("%d\t%s\n",i,app.pm->getPresetName(i).c_str());
}
  
glClearColor(1.0,1.0,0.9,0.0);
emscripten_set_main_loop((void (*)())renderFrame,0,0);
}

void swtcht(){
app.pm->selectRandom(true);
printf("Select random preset.\n");
}
void lckt(){
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
static void opn_aud(){
dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);
if(!dev){
SDL_FreeWAV(wave.snd);
qu(2);
}
SDL_PauseAudioDevice(dev,SDL_FALSE);
}

static void SDLCALL bfr(void *unused,Uint8* stm,int len){
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
char flnm[768];
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
FS.mkdir('/textures');
});
app.done=0;
return 1;
}
