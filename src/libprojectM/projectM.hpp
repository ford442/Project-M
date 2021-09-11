#ifndef _PROJECTM_HPP
#define _PROJECTM_HPP
#ifdef WIN32
#include "dirent.h"
#else
#include <dirent.h>
#endif /** WIN32 */
#include <cmath>
#include <cstdio>
#include <string>
#include <cstdlib>
#ifndef WIN32
#include <unistd.h>
#endif
#include <sys/types.h>
#ifdef __APPLE__
#else
#ifdef WIN32
#include <windows.h>
#endif /** WIN32 */
#endif /** MACOS */
#ifdef WIN32
#pragma comment(lib,"psapi.lib")
#pragma comment(lib,"kernel32.lib")
#endif /** WIN32 */
#include "dlldefs.h"
#include "event.h"
#include "fatal.h"
#include <vector>
class PipelineContext;
#include "PCM.hpp"
class BeatDetect;
class PCM;
class Func;
class Renderer;
class Preset;
class PresetIterator;
class PresetChooser;
class PresetLoader;
class TimeKeeper;
class Pipeline;
class RenderItemMatcher;
class MasterRenderItemMerge;
#include "Common.hpp"
#include <memory>
#ifdef WIN32
#pragma warning (disable:4244)
#pragma warning (disable:4305)
#endif /** WIN32 */
#ifdef __APPLE__2
#define inline
#endif
#define PROJECTM_VERSION "2.0.00"
#define PROJECTM_TITLE "projectM 2.0.00"
typedef enum {
MENU_INTERFACE,
SHELL_INTERFACE,
EDITOR_INTERFACE,
DEFAULT_INTERFACE,
BROWSER_INTERFACE
} interface_t;
class RandomizerFunctor {
public:
RandomizerFunctor(PresetChooser & chooser) ;
virtual ~RandomizerFunctor();
virtual double operator() (int index);
private:
const PresetChooser & m_chooser;
};
class DLLEXPORT projectM{
public:
static const int FLAG_NONE=0;
static const int FLAG_DISABLE_PLAYLIST_LOAD=1 << 0;
struct Settings {
int meshX;
int meshY;
int fps;
int textureSize;
int windowWidth;
int windowHeight;
std::string presetURL;
std::string titleFontURL;
std::string menuFontURL;
std::string datadir;
int smoothPresetDuration;
int presetDuration;
bool hardcutEnabled;
int hardcutDuration;
float hardcutSensitivity;
float beatSensitivity;
bool aspectCorrection;
float easterEgg;
bool shuffleEnabled;
bool softCutRatingsEnabled;
Settings() :
meshX(60),
meshY(60),
fps(60),
textureSize(2048),
windowWidth(1080),
windowHeight(1080),
smoothPresetDuration(1),
presetDuration(60),
hardcutEnabled(true),
hardcutDuration(60),
hardcutSensitivity(2.0),
beatSensitivity(1.0),
aspectCorrection(false),
easterEgg(0.0),
shuffleEnabled(true),
softCutRatingsEnabled(true) {}
};
projectM(std::string config_file,int flags=FLAG_NONE);
projectM(Settings settings,int flags=FLAG_NONE);
void projectM_resetGL(int width,int height);
void projectM_resetTextures();
void projectM_setTitle(std::string title);
void renderFrame();
Pipeline * renderFrameOnlyPass1(Pipeline *pPipeline);
void renderFrameOnlyPass2(Pipeline *pPipeline,int xoffset,int yoffset,int eye);
void renderFrameEndOnSeparatePasses(Pipeline *pPipeline);
unsigned initRenderToTexture();
void key_handler(projectMEvent event,
projectMKeycode keycode,projectMModifier modifier);
virtual ~projectM();
void changeTextureSize(int size);
void changeHardcutDuration(int seconds);
void changePresetDuration(int seconds);
void getMeshSize(int *w,int *h);
void touch(float x,float y,int pressure,int touchtype);
void touchDrag(float x,float y,int pressure);
void touchDestroy(float x,float y);
void touchDestroyAll();
void setHelpText(const std::string & helpText);
void toggleSearchText();
void setToastMessage(const std::string & toastMessage);
const Settings & settings() const {
return _settings;
}
static bool writeConfig(const std::string & configFile,const Settings & settings);
void selectPresetPosition(unsigned int index);
void selectPreset(unsigned int index,bool hardCut=true);
void populatePresetMenu();
void removePreset(unsigned int index);
void setRandomizer(RandomizerFunctor * functor);
void queuePreset(unsigned int index);
bool isPresetQueued() const;
void clearPlaylist();
void setPresetLock(bool isLocked);
bool isPresetLocked() const;
bool isTextInputActive(bool nomin=false) const;
unsigned int getPresetIndex(std::string &url) const;
void selectPresetByName(std::string name,bool hardCut=true);
void setSearchText(const std::string & searchKey);
void deleteSearchText();
void resetSearchText();
bool selectedPresetIndex(unsigned int & index) const;
unsigned int addPresetURL(const std::string & presetURL,const std::string & presetName,const RatingList & ratingList);
void insertPresetURL(unsigned int index,
const std::string & presetURL,const std::string & presetName,const RatingList & ratingList);
bool presetPositionValid() const;
std::string getPresetURL(unsigned int index) const;
std::string getPresetName (unsigned int index) const;
void changePresetName (unsigned int index,std::string name);
int getPresetRating (unsigned int index,const PresetRatingType ratingType) const;
void changePresetRating (unsigned int index,int rating,const PresetRatingType ratingType); 
unsigned int getPlaylistSize() const;
void evaluateSecondPreset();
inline void setShuffleEnabled(bool value){
 _settings.shuffleEnabled=value;
}
inline bool isShuffleEnabled() const{
return _settings.shuffleEnabled;
}
virtual void presetSwitchedEvent(bool,size_t) const{};
virtual void shuffleEnabledValueChanged(bool) const{};
virtual void presetSwitchFailedEvent(bool,unsigned int,const std::string &) const{};
virtual void presetRatingChanged(unsigned int,int,resetRatingType) const{};
inline PCM * pcm(){
return _pcm;
}
void *thread_func(void *vptr_args);
PipelineContext & pipelineContext(){return *_pipelineContext;}
PipelineContext & pipelineContext2(){return *_pipelineContext2;}
int lastPreset=0;
std::vector<int> presetHistory; 
std::vector<int> presetFuture; 
unsigned int getSearchIndex(std::string &name) const;
void selectPrevious(const bool);
void selectNext(const bool);
void selectRandom(const bool);
int getWindowWidth() {return _settings.windowWidth;}
int getWindowHeight() {return _settings.windowHeight;}
bool getErrorLoadingCurrentPreset() const{return errorLoadingCurrentPreset;}
void default_key_handler(projectMEvent event,projectMKeycode keycode);
Renderer *renderer;
private:
PCM * _pcm;
double sampledPresetDuration();
BeatDetect * beatDetect;
PipelineContext * _pipelineContext;
PipelineContext * _pipelineContext2;
Settings _settings;
int wvw; 
int wvh;
int mspf;
int timed;
int timestart;
int count;
float fpsstart;
void readConfig(const std::string &configFile);
void readSettings(const Settings &settings);
void projectM_init(int gx,int gy,int fps,int texsize,int width,int height);
void projectM_reset();
void projectM_initengine();
void projectM_resetengine();
int initPresetTools(int gx,int gy);
void destroyPresetTools();
PresetIterator * m_presetPos;
PresetIterator * m_lastPresetPos;
PresetLoader * m_presetLoader;
PresetChooser * m_presetChooser;
std::unique_ptr<Preset> m_activePreset;
std::unique_ptr<Preset> m_activePreset2;
TimeKeeper *timeKeeper;
int m_flags;
RenderItemMatcher * _matcher;
MasterRenderItemMerge * _merger;
bool running;
bool errorLoadingCurrentPreset;
Pipeline* currentPipe;
std::unique_ptr<Preset> switchToCurrentPreset();
bool startPresetTransition(bool hard_cut);
};
#endif
