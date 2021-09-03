#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <projectM.hpp>
#include <emscripten/emscripten.h>
#include <GLES3/gl3.h>
#include "SDL2/SDL_config.h"
#include <SDL2/SDL.h>
const float FPS = 60;
static SDL_AudioDeviceID dev;
static struct{SDL_AudioSpec spec;Uint8 *snd;Uint32 slen;int pos;}wave;
typedef struct
{
projectM *pm;
SDL_Window *win;
SDL_GLContext *glCtx;
bool done;
projectM::Settings settings;
SDL_AudioDeviceID dev;
}
projectMApp;
projectMApp app;
void renderFrame()
{
auto sndat=reinterpret_cast<short*>(&wave.snd);
unsigned int ll=sizeof(&wave.snd);
app.pm->pcm()->addPCM16Data(sndat,ll);
glClearColor(0.0, 0.0, 0.0, 0.0);
glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
app.pm->renderFrame();
glFlush();
SDL_GL_SwapWindow(app.win);
}
extern "C" {
void swtch(){
emscripten_pause_main_loop();
app.pm->selectRandom(true);
emscripten_resume_main_loop();
}
void lck(){
app.pm->setPresetLock(true);
}
void chng(){
EM_ASM(
FS.mkdir('/presets');
);
int width = EM_ASM_INT({return document.getElementById('ihig').innerHTML;});
int height = width;
app.win = SDL_CreateWindow("Bat files", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,width, height, SDL_WINDOW_OPENGL);
SDL_GLContext glCtx = SDL_GL_CreateContext(app.win);
app.glCtx = &glCtx;
SDL_SetWindowTitle(app.win, "Bat files");
SDL_Log("GL_VERSION: %s", glGetString(GL_VERSION));
SDL_Log("GL_SHADING_LANGUAGE_VERSION: %s", glGetString(GL_SHADING_LANGUAGE_VERSION));
app.settings.meshX = 80;
app.settings.meshY = 80;
app.settings.fps = FPS;
app.settings.textureSize = 2048;
app.settings.windowWidth = width;
app.settings.windowHeight = width;
app.settings.smoothPresetDuration = 1;
app.settings.presetDuration = EM_ASM_INT({return document.getElementById('dura').innerHTML;});
app.settings.beatSensitivity = 1;
app.settings.aspectCorrection = 1;
app.settings.easterEgg = 0;
app.settings.shuffleEnabled = 1;
app.settings.softCutRatingsEnabled = 1;
app.settings.presetURL = "/presets";
app.pm = new projectM(app.settings);
app.pm->selectRandom(true);
app.pm->projectM_resetGL(width, height);
DIR *m_dir;
if ((m_dir = opendir("/")) == NULL)
{
printf("error opening /\n");
}
else
{
struct dirent *dir_entry;
emscripten_set_main_loop((void (*)())renderFrame, 0, 0);
}
static void cls_aud(){if(dev!=0){
SDL_PauseAudioDevice(dev,SDL_TRUE);SDL_CloseAudioDevice(dev);dev=0;
}}
static void qu(int rc){SDL_Quit();exit(rc);
}
static void opn_aud(){dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);
if(!dev){SDL_FreeWAV(wave.snd);qu(2);}SDL_PauseAudioDevice(dev,SDL_FALSE);
}
void SDLCALL bfr(void *unused,Uint8 * stm,int len){
Uint8 *wptr;
int lft;
wptr=wave.snd+wave.pos;lft=wave.slen-wave.pos;
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
void pl(){cls_aud();
char flnm[4096];
SDL_FreeWAV(wave.snd);
SDL_Quit();
SDL_SetMainReady();
if (SDL_Init(SDL_INIT_AUDIO)<0){qu(1);}
SDL_strlcpy(flnm,"/sample.wav",sizeof(flnm));
if(SDL_LoadWAV(flnm,&wave.spec,&wave.snd,&wave.slen)==NULL){qu(1);}
wave.pos=0;
wave.spec.callback=bfr;
opn_aud();
}}
int main()
{
app.done = 0;
SDL_Init(SDL_INIT_VIDEO);
return PROJECTM_SUCCESS;
}
