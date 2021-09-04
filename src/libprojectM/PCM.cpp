#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include "Common.hpp"
#include "wipemalloc.h"
#include "fftsg.h"
#include "PCM.hpp"
#include <cassert>
class AutoLevel{
private:
double level;
size_t level_samples;
double level_sum;
double level_max;
double l0,l1,l2;
public:
AutoLevel() : level(0.01),level_samples(0),level_sum(0),level_max(0),l0(-1),l1(-1),l2(-1){}
#define AUTOLEVEL_SEGMENT 4096
double updateLevel(size_t samples,double sum,double max){
if(sum/samples < 0.00001)
return level;
level_sum += sum;
level_max=fmax(level_max,max*1.02);
level_samples += samples;
if(level_samples >= AUTOLEVEL_SEGMENT || l0 <= 0){
double max_recent=fmax(fmax(l0,l1),fmax(l2,level_max));
l0=l1;l1=l2;l2=level_max;level_max *= 0.95;
level_sum=level_samples=0;
level=(l0 <= 0) ? max_recent : level * 0.96 + max_recent * 0.04;
level=fmax(level,0.0001);
}
return level;
}};
PCM::PCM() : start(0),newsamples(0){
leveler=new AutoLevel();
#if FFT_LENGTH > 1024
#error update this code
#endif
w= (double *)wipemalloc(FFT_LENGTH*sizeof(double));
ip=(int *)wipemalloc(34 * sizeof(int));
ip[0]=0;
memset(pcmL,0,sizeof(pcmL));
memset(pcmR,0,sizeof(pcmR));
memset(freqL,0,sizeof(freqL));
memset(freqR,0,sizeof(freqR));
memset(spectrumL,0,sizeof(spectrumL));
memset(spectrumR,0,sizeof(spectrumR));
}
PCM::~PCM(){
delete leveler;
free(w);
free(ip);
}
#include <iostream>
void PCM::addPCMfloat(const float *PCMdata,size_t samples){
float a,sum=0,max=0;
for(size_t i=0;i<samples;i++){
size_t j=(i+start)%maxsamples;
a=pcmL[j]=PCMdata[i];
pcmR[j]=PCMdata[i];
sum += fabs(a);
max=fmax(max,a);
}
start=(start+samples)%maxsamples;
newsamples += samples;
level=leveler->updateLevel(samples,sum,max);
}
void PCM::addPCMfloat_2ch(const float *PCMdata,size_t count){
size_t samples=count/2;
float a,b,sum=0,max=0;
for(size_t i=0;i<samples;i++){
size_t j=(start+i)%maxsamples;
a=pcmL[j]=PCMdata[i*2];
b=pcmR[j]=PCMdata[i*2+1];
sum += fabs(a) + fabs(b);
max=fmax(fmax(max,fabs(a)),fabs(b));
}
start=(start + samples) % maxsamples;
newsamples += samples;
level=leveler->updateLevel(samples,sum/2,max);
}
void PCM::addPCM16Data(const short* pcm_data,size_t samples){
float a,b,sum=0,max=0;
for(size_t i=0;i < samples;++i){
size_t j=(i + start) % maxsamples;
a=pcmL[j]=(pcm_data[i * 2 + 0] / 16384.0);
b=pcmR[j]=(pcm_data[i * 2 + 1] / 16384.0);
sum += fabs(a) + fabs(b);
max=fmax(fmax(max,a),b);
}
start=(start + samples) % maxsamples;
newsamples += samples;
level=leveler->updateLevel(samples,sum/2,max);
}
void PCM::addPCM16(const short PCMdata[2][512]){
const int samples=512;
float a,b,sum=0,max=0;
for(size_t i=0;i<samples;i++){
size_t j=(i+start) % maxsamples;
a=pcmL[j]=(PCMdata[0][i]/16384.0);
b=pcmR[j]=(PCMdata[1][i]/16384.0);
sum += fabs(a) + fabs(b);
max=fmax(fmax(max,a),b);
}
start=(start+samples) % maxsamples;
newsamples += samples;
level=leveler->updateLevel(samples,sum/2,max);
}
void PCM::addPCM8(const unsigned char PCMdata[2][1024]){
const int samples=1024;
float a,b,sum=0,max=0;
for(size_t i=0;i<samples;i++){
size_t j= (i+start) % maxsamples;
a=pcmL[j]=(((float)PCMdata[0][i] - 128.0) / 64 );
b=pcmR[j]=(((float)PCMdata[1][i] - 128.0) / 64 );
sum += fabs(a) + fabs(b);
max=fmax(fmax(max,a),b);
}
start=(start + samples) % maxsamples;
newsamples += samples;
level=leveler->updateLevel(samples,sum/2,max);
}
void PCM::addPCM8_512(const unsigned char PCMdata[2][512]){
const size_t samples=512;
float a,b,sum=0,max=0;
for(size_t i=0;i<samples;i++){
size_t j=(i+start) % maxsamples;
a=pcmL[j]=(((float)PCMdata[0][i] - 128.0 ) / 64 );
b=pcmR[j]=(((float)PCMdata[1][i] - 128.0 ) / 64 );
sum += fabs(a) + fabs(b);
max=fmax(fmax(max,a),b);
}
start=(start + samples) % maxsamples;
newsamples += samples;
level=leveler->updateLevel(samples,sum/2,max);
}
void PCM::getPCM(float *data,CHANNEL channel,size_t samples,float smoothing){
assert(channel == 0 || channel == 1);
if(0==smoothing){
_copyPCM(data,channel,samples);
return;
}
_updateFFT();
double freq[FFT_LENGTH*2];
double *from=channel==0 ? freqL : freqR;
for(int i=0;i<FFT_LENGTH*2;i++)
freq[i]=from[i];
if(1==0){
double k=-1.0 / ((1 - smoothing) * (1 - smoothing) * FFT_LENGTH * FFT_LENGTH);
for(int i=1;i < FFT_LENGTH;i++){
float g=pow(2.718281828459045,i * i * k);
freq[i * 2] *= g;
freq[i * 2 + 1] *= g;
}
freq[1] *= pow(2.718281828459045,FFT_LENGTH*FFT_LENGTH*k);
}else{
double k=1.0 / ((1 - smoothing) * (1 - smoothing) * FFT_LENGTH * FFT_LENGTH);
for(int i=1;i < FFT_LENGTH;i++){
float b=1.0 / (1.0 + (i * i * k));
freq[i * 2] *= b;
freq[i * 2 + 1] *= b;
}
freq[1] *= 1.0 / (1.0 + (FFT_LENGTH*FFT_LENGTH*k));
}
rdft(FFT_LENGTH*2,-1,freq,ip,w);
for(size_t j=0;j < FFT_LENGTH*2;j++)
freq[j] *= 1.0 / FFT_LENGTH;
size_t count=samples<FFT_LENGTH ? samples : FFT_LENGTH;
for(size_t i=0;i<count;i++)
data[i]=freq[i%(FFT_LENGTH*2)];
for(size_t i=count;i<samples;i++)
data[i]=0;
}
void PCM::getSpectrum(float *data,CHANNEL channel,size_t samples,float smoothing){
assert(channel == 0 || channel == 1);
_updateFFT();
float *spectrum=channel == 0 ? spectrumL : spectrumR;
if(smoothing == 0){
size_t count=samples <= FFT_LENGTH ? samples : FFT_LENGTH;
for(size_t i=0;i < count;i++)
data[i]=spectrum[i];
for(size_t i=count;i < samples;i++)
data[0]=0;
}else{
float l2=0,l1 =0 ,c=0,r1,r2;
r1=spectrum[0];r2=spectrum[0+1];
for(size_t i=0;i < samples;i++){
l2=l1;
l1=c;
c=r1;
r1=r2;
r2=(i + 2) >= samples ? 0 : spectrum[i + 2];
data[i]=(l2 + 4 * l1 + 6 * c + 4 * r1 + r2) / 16.0;
}}}
void PCM::_updateFFT(){
if(newsamples > 0){
_updateFFT(0);
_updateFFT(1);
newsamples=0;
}}
void PCM::_updateFFT(size_t channel){
assert(channel == 0 || channel == 1);
double *freq=channel==0 ? freqL : freqR;
_copyPCM(freq,channel,FFT_LENGTH*2);
rdft(FFT_LENGTH*2,1,freq,ip,w);
float *spectrum=channel==0 ? spectrumL : spectrumR;
for(size_t i=1;i<FFT_LENGTH;i++){
double m2=(freq[i * 2] * freq[i * 2] + freq[i * 2 + 1] * freq[i * 2 + 1]);
spectrum[i-1]=m2 * ((double)i)/FFT_LENGTH;
}
spectrum[FFT_LENGTH-1]=freq[1] * freq[1];
}
inline double constrain(double a,double mn,double mx){
return a>mx ? mx : a<mn ? mn : a;
}
void PCM::_copyPCM(float *to,int channel,size_t count){
assert(channel == 0 || channel == 1);
assert(count < maxsamples);
const float *from=channel==0 ? pcmL : pcmR;
const double volume=1.0 / level;
for(size_t i=0,pos=start;i<count;i++){
if(pos==0)
pos=maxsamples;
to[i]=from[--pos] * volume;
}}
void PCM::_copyPCM(double *to,int channel,size_t count){
assert(channel == 0 || channel == 1);
const float *from=channel==0 ? pcmL : pcmR;
const double volume=1.0 / level;
for(size_t i=0,pos=start;i<count;i++){
if(pos==0)
pos=maxsamples;
to[i]=from[--pos] * volume;
}}
void PCM::freePCM(){
free(ip);
free(w);
ip=NULL;
w=NULL;
}
#include "TestRunner.hpp"
#ifndef NDEBUG
#include "PresetLoader.hpp"
#define TEST(cond) if(!verify(__FILE__ ": " #cond,cond)) return false
#define TEST2(str,cond) if(!verify(str,cond)) return false
struct PCMTest : public Test{
PCMTest() : Test("PCMTest"){}
bool eq(float a,float b){
return fabs(a-b) < (fabs(a)+fabs(b) + 1)/1000.0f;
}
public:
bool test_addpcm(){
PCM pcm;{
const size_t samples=301;
float *data=new float[samples];
for(size_t i=0;i < samples;i++)
data[i]=((float) i) / (samples - 1);
for(size_t i=0;i < 10;i++)
pcm.addPCMfloat(data,samples);
float *copy=new float[samples];
pcm.level=1.0;
pcm._copyPCM(copy,0,samples);
for(size_t i=0;i < samples;i++)
TEST(eq(copy[i],((float)samples - 1 - i) / (samples - 1)));
pcm._copyPCM(copy,1,samples);
for(size_t i=0;i < samples;i++)
TEST(eq(copy[i],((float)samples - 1 - i) / (samples - 1)));
free(data);
free(copy);
}{
const size_t samples=301;
float *data=new float[samples*2];
for(size_t i=0;i < samples;i++){
data[i*2]=((float) i) / (samples - 1);
data[i*2+1]=1.0-data[i*2];
}
for(size_t i=0;i < 10;i++)
pcm.addPCMfloat_2ch(data,samples*2);
float *copy0=new float[samples];
float *copy1=new float[samples];
pcm.level=1;
pcm._copyPCM(copy0,0,samples);
pcm._copyPCM(copy1,1,samples);
for(size_t i=0;i < samples;i++)
TEST(eq(1.0,copy0[i]+copy1[i]));
free(data);
free(copy0);
free(copy1);
}
return true;
}
bool test_fft(){
PCM pcm;{
const size_t samples=1024;
float *data=new float[samples * 2];
for(size_t i=0;i < samples;i++){
float f=2 * 3.141592653589793 * ((double) i) / (samples - 1);
data[i * 2]=sin(f);
data[i * 2 + 1]=sin(f + 1.0);// out of phase
}
pcm.addPCMfloat_2ch(data,samples * 2);
pcm.addPCMfloat_2ch(data,samples * 2);
float *freq0=new float[FFT_LENGTH];
float *freq1=new float[FFT_LENGTH];
pcm.level=1.0;
pcm.getSpectrum(freq0,CHANNEL_0,FFT_LENGTH,0.0);
pcm.getSpectrum(freq1,CHANNEL_1,FFT_LENGTH,0.0);
for(size_t i=0;i < FFT_LENGTH;i++)
TEST(eq(freq0[i],freq1[i]));
TEST(freq0[0] > 500);
for(size_t i=1;i < FFT_LENGTH;i++)
TEST(freq0[i] < 0.1);
free(data);
free(freq0);
free(freq1);
}{
const size_t samples=2;
float data[4]={1.0,0.0,0.0,1.0};
for(size_t i=0;i < 1024;i++)
pcm.addPCMfloat_2ch(data,samples * 2);
float *freq0=new float[FFT_LENGTH];
float *freq1=new float[FFT_LENGTH];
pcm.level=1.0;
pcm.getSpectrum(freq0,CHANNEL_0,FFT_LENGTH,0.0);
pcm.getSpectrum(freq1,CHANNEL_1,FFT_LENGTH,0.0);
for(size_t i=0;i < FFT_LENGTH;i++)
TEST(eq(freq0[i],freq1[i]));
for(size_t i=0;i<FFT_LENGTH-1;i++)
TEST(0==freq0[i]);
TEST(freq0[FFT_LENGTH-1] > 100000);
free(freq0);
free(freq1);
}
return true;
}
bool test() override{
TEST(test_addpcm());
TEST(test_fft());
return true;
}};
Test* PCM::test(){
return new PCMTest();
}
#else
Test* PCM::test(){
return nullptr;
}
#endif
