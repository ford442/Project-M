/**
 * ProjectM with Emscripten and SDL2
 *  Mischa Spiegelmock, 2014, 2021
 *
 */

#include <math.h>
#include <projectM.hpp>

#ifdef __APPLE__
#include <OpenGL/gl.h>
#include <SDL2/SDL.h>
#elif EMSCRIPTEN
#include <emscripten.h>
#include <GLES3/gl3.h>
#include <SDL2/SDL.h>
#endif
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
int selectAudioInput(projectMApp *app_)
{
	int i, count = SDL_GetNumAudioDevices(0); // param=isCapture (not yet functional)
	if (!count)
	{
		fprintf(stderr, "No audio input capture devices detected\n");
		return 0;
	}
	printf("count: %d\n", count);
	for (i = 0; i < count; ++i)
	{
		printf("Audio device %d: %s\n", i, SDL_GetAudioDeviceName(i, 0));
	}
	return 1;
}
void renderFrame()
{
	int i;
	short pcm_data[2][512];
	SDL_Event evt;
	SDL_PollEvent(&evt);
	switch (evt.type)
	{
		case SDL_KEYDOWN:
			break;
		case SDL_QUIT: app.done = true;
			break;
	}
	/** Produce some fake PCM data to stuff into projectM */
	for (i = 0; i < 512; i++)
	{
		if (i % 2 == 0)
		{
			pcm_data[0][i] = (float)(rand() / ((float)RAND_MAX) * (pow(2, 14)));
			pcm_data[1][i] = (float)(rand() / ((float)RAND_MAX) * (pow(2, 14)));
		}
		else
		{
			pcm_data[0][i] = (float)(rand() / ((float)RAND_MAX) * (pow(2, 14)));
			pcm_data[1][i] = (float)(rand() / ((float)RAND_MAX) * (pow(2, 14)));
		}
		if (i % 2 == 1)
		{
			pcm_data[0][i] = -pcm_data[0][i];
			pcm_data[1][i] = -pcm_data[1][i];
		}
	}
	/** Add the waveform data */
	app.pm->pcm()->addPCM16(pcm_data);
	glClearColor(0.0, 0.0, 0.0, 0.0);
	glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
	app.pm->renderFrame();
	glFlush();
	SDL_GL_SwapWindow(app.win);
}
void chng(){
app.pm->selectRandom(true);
}
int main(int argc, char *argv[])
{
MAIN_THREAD_EM_ASM(
FS.mkdir('/presets');
let ff=new XMLHttpRequest();
ff.open("GET","./Phat_Rovastar_EoS_spiral_faces.milk",true);
ff.responseType="arraybuffer";
ff.onload=function(oEvent){
let arrayBuffer=ff.response;
if(arrayBuffer){
let fil=new Uint8ClampedArray(arrayBuffer);
FS.writeFile('/presets/tst.milk',fil);
console.log('File written to /presets/tst.milk.');
Module.ccall('chng');
}};
ff.send(null);
);
	app.done = 0;
	int width = 1920, height = 1080;
	SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO);
	// get an audio input device
	if (!selectAudioInput(&app))
	{
		fprintf(stderr, "Failed to open audio input device\n");
		return 1;
	}
	// initialize window
	app.win = SDL_CreateWindow("SDL Fun Party Time", SDL_WINDOWPOS_UNDEFINED, SDL_WINDOWPOS_UNDEFINED,width, height, SDL_WINDOW_OPENGL);
	SDL_GLContext glCtx = SDL_GL_CreateContext(app.win);
	if (!glCtx) fatal("failed to create GL context %s\n", SDL_GetError());
	// associate GL context with main window
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
#ifdef EMSCRIPTEN
	app.settings.presetURL = "/presets";
#else
	app.settings.presetURL = "presets_tryptonaut";
	app.settings.menuFontURL = "fonts/Vera.ttf";
	app.settings.titleFontURL = "fonts/Vera.ttf";
#endif
	// init projectM
	app.pm = new projectM(app.settings);
	printf("Init ProjectM\n");
	app.pm->selectRandom(true);
	printf("Select random preset.\n");
	app.pm->projectM_resetGL(width, height);
	printf("Reseting GL.\n");
	app.pm->selectNext(true);
	printf("Different preset?\n");
	app.pm->selectNext(true);
	printf("Different preset?\n");
	// Allocate a new a stream given the current directory name
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
		}
	}
	for (int i = 0; i < app.pm->getPlaylistSize(); i++)
	{
		printf("%d\t%s\n", i, app.pm->getPresetName(i).c_str());
	}
	// mainloop. non-emscripten version here for comparison/testing
#ifdef EMSCRIPTEN
	emscripten_set_main_loop((void (*)())renderFrame, 0, 0);
#else
	// standard main loop
	const Uint32 frame_delay = 1000 / FPS;
	Uint32 last_time = SDL_GetTicks();
	while (!app.done)
	{
		renderFrame(&app);
		Uint32 elapsed = SDL_GetTicks() - last_time;
		if (elapsed < frame_delay) SDL_Delay(frame_delay - elapsed);
		last_time = SDL_GetTicks();
	}
#endif
	return PROJECTM_SUCCESS;
}
