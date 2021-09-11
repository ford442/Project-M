#ifndef WAVEFORM_HPP_
#define WAVEFORM_HPP_
#include "Renderable.hpp"
#include <vector>
class ColoredPoint{
public:
float x;
float y;
float r;
float g;
float b;
float a;
ColoredPoint():x(0.5),y(0.5),r(1),g(1),b(1),a(1){}};
class WaveformContext{
public:
float sample;
int samples;
int sample_int;
float left;
float right;
BeatDetect *music;
WaveformContext(int _samples,BeatDetect *_music):samples(_samples),music(_music){}};
class Waveform : public RenderItem{
public:
int samples;
bool spectrum; 
bool dots; 
bool thick;
bool additive;
float scaling;
float smoothing; 
int sep; 
Waveform(int _samples);
void InitVertexAttrib();
void Draw(RenderContext &context);
private:
virtual ColoredPoint PerPoint(ColoredPoint p,const WaveformContext context)=0;
std::vector<ColoredPoint> points;
std::vector<float> pointContext;
};
#endif /* WAVEFORM_HPP_ */
