#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <projectM.hpp>
#include <emscripten/emscripten.h>
#include <GLES3/gl3.h>
#include "SDL2/SDL_config.h"
#include <SDL2/SDL.h>

const float FPS = 60;
typedef struct
{
projectM *pm;
SDL_Window *win;
SDL_GLContext *glCtx;
bool done;
projectM::Settings settings;
SDL_AudioDeviceID audioInputDevice;
} projectMApp;
projectMApp app;
static void fatal(const char *const fmt, ...)
{
va_list args;
va_start(args, fmt);
vprintf(fmt, args);
printf("\n");
va_end(args);
SDL_Quit();
}
void renderFrame()
{
Uint8 stm;
int i;
SDL_Event evt;
SDL_PollEvent(&evt);
switch (evt.type)
{
case SDL_KEYDOWN:
break;
case SDL_QUIT: app.done = true;
break;
}

// app.pm->pcm()->addPCM8_512(stm);
  
glClearColor(0.0, 0.0, 0.0, 0.0);
glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
app.pm->renderFrame();
glFlush();
SDL_GL_SwapWindow(app.win);
}
extern "C" {
static struct{SDL_AudioSpec spec;Uint8 *snd;Uint32 slen;int pos;}wave;
static SDL_AudioDeviceID dev;
static void cls_aud(){if(dev!=0){SDL_PauseAudioDevice(dev,SDL_TRUE);SDL_CloseAudioDevice(dev);dev=0;}}
static void qu(int rc){SDL_Quit();exit(rc);}
static void opn_aud(){dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);if(!dev){SDL_FreeWAV(wave.snd);qu(2);}SDL_PauseAudioDevice(dev,SDL_FALSE);}
static void reopn_aud(){cls_aud();opn_aud();}
void SDLCALL bfr(void *unused,Uint8 *stm,int len){Uint8 *wptr;int lft;wptr=wave.snd+wave.pos;lft=wave.slen-wave.pos;
while (lft<=len){SDL_memcpy(stm,wptr,lft);stm+=lft;len-=lft;wptr=wave.snd;lft=wave.slen;wave.pos=0;}
SDL_memcpy(stm,wptr,len);wave.pos+=len;}
void pl(){cls_aud();char flnm[4096];
SDL_FreeWAV(wave.snd);SDL_Quit();
SDL_SetMainReady();
SDL_strlcpy(flnm,"/sample.wav",sizeof(flnm));
if(SDL_LoadWAV(flnm,&wave.spec,&wave.snd,&wave.slen)==NULL){qu(1);}
wave.pos=0;
wave.spec.callback=bfr;opn_aud();
}
void chng(){
int width = 1920, height = 1080;
app.win = SDL_CreateWindow("SDL Fun Party Time", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,width, height, SDL_WINDOW_OPENGL);
SDL_GLContext glCtx = SDL_GL_CreateContext(app.win);
if (!glCtx) fatal("failed to create GL context %s\n", SDL_GetError());
if (SDL_GL_MakeCurrent(app.win, glCtx)) fatal("failed to bind window to context");
app.glCtx = &glCtx;
SDL_SetWindowTitle(app.win, "SDL Fun Party Time");
SDL_Log("GL_VERSION: %s", glGetString(GL_VERSION));
SDL_Log("GL_SHADING_LANGUAGE_VERSION: %s", glGetString(GL_SHADING_LANGUAGE_VERSION));
#ifdef PANTS
if (fsaa)
{
SDL_GL_GetAttribute(SDL_GL_MULTISAMPLEBUFFERS, &value);
printf("SDL_GL_MULTISAMPLEBUFFERS: requested 1, got %d\n", value);
SDL_GL_GetAttribute(SDL_GL_MULTISAMPLESAMPLES, &value);
printf("SDL_GL_MULTISAMPLESAMPLES: requested %d, got %d\n", fsaa, value);
}
#endif
app.settings.meshX = 60;
app.settings.meshY = 40;
app.settings.fps = FPS;
app.settings.textureSize = 1024; // idk?
app.settings.windowWidth = width;
app.settings.windowHeight = height;
app.settings.smoothPresetDuration = 7; // seconds
app.settings.presetDuration = 17;			 // seconds
app.settings.beatSensitivity = 0.8;
app.settings.aspectCorrection = 1;
app.settings.easterEgg = 0; // ???
app.settings.shuffleEnabled = 1;
app.settings.softCutRatingsEnabled = 0; // ???
app.settings.presetURL = "/presets";
app.pm = new projectM(app.settings);
printf("Init ProjectM\n");
app.pm->selectRandom(true);
printf("Select random preset.\n");
app.pm->projectM_resetGL(width, height);
printf("Reseting GL.\n");
DIR *m_dir;
if ((m_dir = opendir("/")) == NULL)
{
printf("error opening /\n");
}
else
{
struct dirent *dir_entry;
while ((dir_entry = readdir(m_dir)) != NULL)
{
printf("%s\n", dir_entry->d_name);
}}
for (int i = 0; i < app.pm->getPlaylistSize(); i++)
{
printf("%d\t%s\n", i, app.pm->getPresetName(i).c_str());
}
emscripten_set_main_loop((void (*)())renderFrame, 0, 0);
app.pm->selectRandom(true);
}}
int main(int argc, char *argv[])
{
MAIN_THREAD_EM_ASM(
FS.mkdir('/presets');
let ff=new XMLHttpRequest();
ff.open("GET","./presets/tearshigh.milk",true);
ff.responseType="arraybuffer";
ff.onload=function(oEvent){
let arrayBuffer=ff.response;
if(arrayBuffer){
let fil=new Uint8ClampedArray(arrayBuffer);
FS.writeFile('/presets/tst1.milk',fil);
console.log('File written to /presets/tst1.milk.');

document.getElementById('btn').addEventListener('click',function(){
Module.ccall('chng');
});
}};
ff.send(null);
);
app.done = 0;
SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
return PROJECTM_SUCCESS;
}
