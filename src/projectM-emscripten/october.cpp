#include <emscripten/emscripten.h>
#include <emscripten/html5.h>

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
// EGL_CONTEXT_OPENGL_PROFILE_MASK_KHR,EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT_KHR,
// EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,
// EGL_RENDERABLE_TYPE,EGL_OPENGL_BIT,
// EGL_CONTEXT_OPENGL_ROBUST_ACCESS_EXT,EGL_TRUE,
EGL_DEPTH_ENCODING_NV,EGL_DEPTH_ENCODING_NONLINEAR_NV,
EGL_RENDER_BUFFER,EGL_QUADRUPLE_BUFFER_NV,
// EGL_CONTEXT_OPENGL_FORWARD_COMPATIBLE,EGL_TRUE,
EGL_RED_SIZE,8,
EGL_GREEN_SIZE,8,
EGL_BLUE_SIZE,8,
EGL_ALPHA_SIZE,8,
EGL_DEPTH_SIZE,32,
EGL_STENCIL_SIZE,8,
EGL_BUFFER_SIZE,32,
EGL_SAMPLE_BUFFERS,1,
EGL_SAMPLES,32,
EGL_NONE
};

emscripten_webgl_init_context_attributes(&attr);
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
EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx=emscripten_webgl_create_context("#pcanvas",&attr);
EGLConfig eglconfig=NULL;
double wi,hi;
emscripten_get_element_css_size("pcanvas",&wi,&hi);
// eglBindAPI(EGL_OPENGL_API);
display=eglGetDisplay(EGL_DEFAULT_DISPLAY);
surface=eglCreateWindowSurface(display,eglconfig,(NativeWindowType)0,attribut_list);
eglInitialize(display,&major,&minor);
eglChooseConfig(display,attribute_list,&eglconfig,(EGLint)1,&config_size);
contextegl=eglCreateContext(display,eglconfig,EGL_NO_CONTEXT,anEglCtxAttribs2);
eglMakeCurrent(display,surface,surface,contextegl);
emscripten_webgl_make_context_current(ctx);
int Size=(int)hi;
float S=(float)hi;
// eglBindAPI(EGL_OPENGL_ES_API);

int width=Size;
int height=Size;
glViewport(0,0,600,600);
SDL_Log("GL_VERSION: %s",glGetString(GL_VERSION));
SDL_Log("GLSL_VERSION: %s",glGetString(GL_SHADING_LANGUAGE_VERSION));
std::cout<<glGetString(GL_VERSION)<<"\n";
std::cout<<glGetString(GL_SHADING_LANGUAGE_VERSION)<<"\n";

app.settings.meshX=24;
app.settings.meshY=24;
app.settings.textureSize=128;
app.settings.fps=FPS;
app.settings.windowWidth=600;
app.settings.windowHeight=600;
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
