#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <projectM.hpp>
#include <emscripten/emscripten.h>
#include <GLES3/gl3.h>
#include "SDL2/SDL_config.h"
#include <SDL2/SDL.h>
//  VIDEO
void pl();
void renderFrame();
short pcmsnd[2][512];
const float FPS=60;
static SDL_AudioDeviceID dev;
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
app.pm->pcm()->addPCM16(pcmsnd);
glClearColor(0.0, 0.5, 0.0, 0.0);
glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
app.pm->renderFrame();
glFlush();
SDL_GL_SwapWindow(app.win);
}
extern "C" {
void chng(){
int width = 1920, height = 1080;
app.win = SDL_CreateWindow("Bat files", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,width, height, SDL_WINDOW_OPENGL);
SDL_GLContext glCtx = SDL_GL_CreateContext(app.win);
app.glCtx = &glCtx;
SDL_SetWindowTitle(app.win, "Bat files");
SDL_Log("GL_VERSION: %s", glGetString(GL_VERSION));
SDL_Log("GL_SHADING_LANGUAGE_VERSION: %s", glGetString(GL_SHADING_LANGUAGE_VERSION));
app.settings.meshX = 60;
app.settings.meshY = 40;
app.settings.fps = FPS;
app.settings.textureSize = 2048;
app.settings.windowWidth = width;
app.settings.windowHeight = height;
app.settings.smoothPresetDuration = 7;
app.settings.presetDuration = 555;
app.settings.beatSensitivity = 1;
app.settings.aspectCorrection = 1;
app.settings.easterEgg = 0;
app.settings.shuffleEnabled = 1;
app.settings.softCutRatingsEnabled = 1;
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
for (uint i = 0; i < app.pm->getPlaylistSize(); i++)
{
printf("%d\t%s\n", i, app.pm->getPresetName(i).c_str());
}
emscripten_set_main_loop((void (*)())renderFrame, 0, 0);
}
//  SOUND
static struct{SDL_AudioSpec spec;Uint8 *snd;Uint32 slen;int pos;}wave;
static void cls_aud(){if(dev!=0){SDL_PauseAudioDevice(dev,SDL_TRUE);SDL_CloseAudioDevice(dev);dev=0;}}
static void qu(int rc){SDL_Quit();exit(rc);}
static void opn_aud(){dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);if(!dev){SDL_FreeWAV(wave.snd);qu(2);}SDL_PauseAudioDevice(dev,SDL_FALSE);}
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
for(int i=0;i<512;i++){for(int j=0;j<1;j++){pcmsnd[j][i]=snd[i+j];}}
SDL_memcpy(stm,wptr,len);
wave.pos+=len;
}
void pl(){cls_aud();char flnm[128];
SDL_FreeWAV(wave.snd);SDL_Quit();
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
EM_ASM(
FS.mkdir('/presets');
);
app.done = 0;
SDL_Init(SDL_INIT_VIDEO);
return PROJECTM_SUCCESS;
}
