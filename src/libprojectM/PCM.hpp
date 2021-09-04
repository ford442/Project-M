#ifndef _PCM_H
#define _PCM_H
#include <stdlib.h>
#include "dlldefs.h"
#define FFT_LENGTH 512
class Test;
class AutoLevel;
enum CHANNEL{
CHANNEL_L=0,
CHANNEL_0=0,
CHANNEL_R=1,
CHANNEL_1=1
};
class 
#ifdef WIN32 
DLLEXPORT 
#endif 
PCM{
public:
static const size_t maxsamples=2048;
PCM();
~PCM();
void addPCMfloat( const float *PCMdata,size_t samples);
void addPCMfloat_2ch( const float *PCMdata,size_t count);
void addPCM16( const short [2][512]);
void addPCM16Data( const short* pcm_data,size_t samples);
void addPCM8( const unsigned char [2][1024]);
void addPCM8_512( const unsigned char [2][512]);
void getPCM(float *data,CHANNEL channel,size_t samples,float smoothing);
void getSpectrum(float *data,CHANNEL channel,size_t samples,float smoothing);
static Test* test();
private:
float pcmL[maxsamples];
float pcmR[maxsamples];
int start;
size_t newsamples;
double freqL[FFT_LENGTH*2];
double freqR[FFT_LENGTH*2];
float spectrumL[FFT_LENGTH];
float spectrumR[FFT_LENGTH];
int *ip;
double *w;
void freePCM();
void _copyPCM(float *PCMdata,int channel,size_t count);
void _copyPCM(double *PCMdata,int channel,size_t count);
void _updateFFT();
void _updateFFT(size_t channel);
friend class PCMTest;
double level;
class AutoLevel *leveler;
};
#endif
