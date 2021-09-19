#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <projectM.hpp>
#include <emscripten/emscripten.h>
#include <GLES3/gl3.h>
#include "SDL2/SDL_config.h"
#include <SDL2/SDL.h>
static SDL_AudioDeviceID dev;
static struct{SDL_AudioSpec spec;Uint8 *snd;Uint32 slen;int pos;}wave;
typedef struct{projectM *pm;SDL_Window *win;SDL_GLContext *glCtx;bool done;projectM::Settings settings;SDL_AudioDeviceID dev;}
projectMApp;projectMApp app;
void renderFrame(){
auto sndBuf=wave.snd+wave.pos;
auto sndat=reinterpret_cast<short*>(sndBuf);
// unsigned int ll=sizeof(sndBuf);
app.pm->pcm()->addPCM16Data(sndat,1024);
glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
app.pm->renderFrame();
glFlush();
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
void chngt(){
const float FPS=60.0;
SDL_SetMainReady();
SDL_Init(SDL_INIT_VIDEO);
unsigned int width=EM_ASM_INT({return document.getElementById('ihig').innerHTML;});
unsigned int height=width;
app.win=SDL_CreateWindow("pm",SDL_WINDOWPOS_UNDEFINED,SDL_WINDOWPOS_UNDEFINED,width,height,SDL_WINDOW_OPENGL);
SDL_GLContext glCtx=SDL_GL_CreateContext(app.win);
app.glCtx=&glCtx;
SDL_SetWindowTitle(app.win,"1inkDrop - [from 1ink.us]");
SDL_Log("GL_VERSION: %s",glGetString(GL_VERSION));
SDL_Log("GL_SHADING_LANGUAGE_VERSION: %s",glGetString(GL_SHADING_LANGUAGE_VERSION));
app.settings.meshX=127.0;
app.settings.meshY=127.0;
app.settings.fps=60.0;
app.settings.textureSize=1024;
app.settings.windowWidth=width;
app.settings.windowHeight=width;
app.settings.smoothPresetDuration=17.0;
app.settings.presetDuration=88.0;
app.settings.presetURL="/presets";
app.pm=new projectM(app.settings);
printf("Init ProjectM\n");
app.pm->selectRandom(true);
printf("Select random preset.\n");
app.pm->setPresetLock(true);
printf("Preset locked.\n");
app.pm->projectM_resetGL(width,height);
printf("Reseting GL.\n");
DIR *m_dir;
wchar_t d_name[128];
if((m_dir=opendir("/"))==NULL){printf("error opening /\n");
}else{
struct dirent *dir_entry;
while((dir_entry=readdir(m_dir))!=NULL){printf("%s\n",dir_entry->d_name);
}}
for(unsigned int i=0;i<app.pm->getPlaylistSize();i++){
printf("%d\t%s\n",i,app.pm->getPresetName(i).c_str());
}
glClearColor(0.0,0.5,0.0,0.0);
emscripten_set_main_loop((void (*)())renderFrame,0,0);
}
void cls_aud(){if(dev!=0){
SDL_PauseAudioDevice(dev,SDL_TRUE);
SDL_CloseAudioDevice(dev);
dev=0;
}}
void qu(int rc){
SDL_Quit();exit(rc);
}
void opn_aud(){
dev=SDL_OpenAudioDevice(NULL,SDL_FALSE,&wave.spec,NULL,0);
if(!dev){SDL_FreeWAV(wave.snd);qu(2);}
SDL_PauseAudioDevice(dev,SDL_FALSE);
}
void SDLCALL bfr(void *unused,Uint8 * stm,int len){
Uint8 *wptr;
unsigned int lft;
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
cls_aud();
char flnm[1024];
SDL_FreeWAV(wave.snd);
SDL_Quit();
SDL_SetMainReady();
if (SDL_Init(SDL_INIT_AUDIO)<0){qu(1);}
SDL_strlcpy(flnm,"/sample.wav",sizeof(flnm));
if(SDL_LoadWAV(flnm,&wave.spec,&wave.snd,&wave.slen)==NULL){
qu(1);
}
wave.pos=0;
wave.spec.callback=bfr;
opn_aud();
}
extern "C" {
void pl(){plt();}
void chng(){chngt();}
void lck(){lckt();}
void swtch(){swtcht();}}
int main(){
EM_ASM({
FS.mkdir('/presets');
});
app.done=0;
return 1;
}
