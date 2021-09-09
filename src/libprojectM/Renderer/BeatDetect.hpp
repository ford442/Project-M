#ifndef _BEAT_DETECT_H
#define _BEAT_DETECT_H
#include "../PCM.hpp"
#include "../dlldefs.h"
#include <algorithm>
#include <cmath>
#define BEAT_HISTORY_LENGTH 80
class DLLEXPORT BeatDetect
{
public:
float beatSensitivity;
float treb;
float mid;
float bass;
float vol_old;
float treb_att;
float mid_att;
float bass_att;
float vol;
float vol_att;
PCM *pcm;
explicit BeatDetect(PCM *pcm);
~BeatDetect();
void reset();
void detectFromSamples();
void getBeatVals( float samplerate,unsigned fft_length,float *vdataL,float *vdataR );
float getPCMScale()
{
return beatSensitivity;
}
private:
int beat_buffer_pos;
float bass_buffer[BEAT_HISTORY_LENGTH];
float bass_history;
float bass_instant;
float mid_buffer[BEAT_HISTORY_LENGTH];
float mid_history;
float mid_instant;
float treb_buffer[BEAT_HISTORY_LENGTH];
float treb_history;
float treb_instant;
float vol_buffer[BEAT_HISTORY_LENGTH];
float vol_history;
float vol_instant;
};
#endif /** !_BEAT_DETECT_H */
