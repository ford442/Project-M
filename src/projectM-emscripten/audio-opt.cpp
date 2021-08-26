#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <projectM.hpp>
#include <emscripten/emscripten.h>
#include <GLES3/gl3.h>
#include "SDL2/SDL_config.h"
#include <SDL2/SDL.h>
const float FPS=42;
static SDL_AudioDeviceID dev;
static struct{SDL_AudioSpec spec;Uint8 *s;Uint32 sl;int p;}w;
typedef struct
{
projectM *pm;
SDL_Window *wn;
SDL_GLContext *ctx;
bool E;
projectM::Settings stt;
SDL_AudioDeviceID dev;
}
projectMApp;
projectMApp A;
void $rn()
{
glClearColor(0.0,0.5,0.0,0.0);
glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);
A.pm->$rn();
glFlush();
SDL_GL_SwapWindow(A.wn);
auto sat=reinterpret_cast<short*>(&w.s);
unsigned int ll=sizeof(&w.s);
A.pm->pcm()->addPCM16Data(sat,ll);
}
extern "C"{
void swtch(){
A.pm->selectRandom(true);
}
void chng(){
int ww=EM_ASM_INT({return document.getElementById('ihig').innerHTML;});
int hh=ww;
A.wn=SDL_CreateWindow("Bat files",SDL_WINDOWPOS_UNDEFINED,SDL_WINDOWPOS_UNDEFINED,ww,hh,SDL_WINDOW_OPENGL);
SDL_GLContext ctx=SDL_GL_CreateContext(A.wn);
A.ctx=&ctx;
SDL_SetWindowTitle(A.wn,"Bat files");
SDL_Log("GL_VERSION: %s",glGetString(GL_VERSION));
SDL_Log("GL_SHADING_LANGUAGE_VERSION: %s",glGetString(GL_SHADING_LANGUAGE_VERSION));
A.stt.meshX=42;
A.stt.meshY=42;
A.stt.fps=FPS;
A.stt.textureSize=1024;
A.stt.windowWidth=ww;
A.stt.windowHeight=ww;
A.stt.smoothPresetDuration=3;
A.stt.presetDuration=EM_ASM_INT({return document.getElementById('dura').innerHTML;});
A.stt.beatSensitivity=0.9;
A.stt.aspectCorrection=0;
A.stt.easterEgg=0;
A.stt.shuffleEnabled=1;
A.stt.softCutRatingsEnabled=1;
A.stt.presetURL="/presets";
A.pm=new projectM(A.stt);
printf("Init ProjectM\n");
A.pm->selectRandom(true);
printf("Select random preset.\n");
A.pm->projectM_resetGL(ww,hh);
printf("Reseting GL.\n");
DIR *m_dir;
if ((m_dir=opendir("/"))==NULL)
{
printf("error opening /\n");
}
else
{
struct dirent *dir;
while((dir=readdir(m_dir))!=NULL)
{
printf("%s\n",dir->d_name);
}}
for(uint i=0;i<A.pm->getPlaylistSize();i++)
{
printf("%d\t%s\n",i,A.pm->getPresetName(i).c_str());
}
emscripten_set_main_loop((void(*)())$rn,0,0);
}
static void c(){if(dev!=0){
SDL_PauseAudioDevice(dev,SDL_TRUE);
SDL_CloseAudioDevice(dev);dev=0;
}}
static void qu(int rc){SDL_Quit();
    exit(rc);
}
static void o(){dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&w.spec,NULL,0);
if(!dev){SDL_FreeWAV(w.s);qu(2);}SDL_PauseAudioDevice(dev,SDL_FALSE);
}
void SDLCALL bfr(void *nan,Uint8 * ss,int len){
Uint8 *tr;
int lft;
tr=w.s+w.p;lft=w.sl-w.p;
while(lft<=len){
SDL_memcpy(ss,tr,lft);
ss+=lft;
len-=lft;
tr=w.s;
lft=w.sl;
w.p=0;
}
SDL_memcpy(ss,tr,len);
w.p+=len;
}
void pl(){c();
char flnm[4096];
SDL_FreeWAV(w.s);
SDL_Quit();
SDL_SetMainReady();
if(SDL_Init(SDL_INIT_AUDIO)<0){qu(1);}
SDL_strlcpy(flnm,"/sample.wav",sizeof(flnm));
if(SDL_LoadWAV(flnm,&w.spec,&w.s,&w.sl)==NULL){qu(1);}
w.p=0;
w.spec.callback=bfr;
o();
}}
int main()
{
EM_ASM(
FS.mkdir('/presets');
);
A.E=0;
SDL_Init(SDL_INIT_VIDEO);
return PROJECTM_SUCCESS;
}
