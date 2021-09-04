#ifndef COMMON_HPP
#define COMMON_HPP
#include <vector>
#include <typeinfo>
#include <cstdarg>
#include <cassert>
#include <locale>
#ifdef _MSC_VER
#define strcasecmp(s,t) _strcmpi(s,t)
#endif
#if defined(_MSC_VER ) && !defined(EYETUNE_WINRT)
#pragma warning( disable : 4244 4305 4996; once : 4018 )
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
typedef unsigned int uint;
#endif
#ifdef DEBUG
#endif
#ifdef __APPLE__
#include <cstdio>
extern FILE *fmemopen(void *buf,size_t len,const char *pMode);
#endif /** MACOS */
#include "dlldefs.h"
#define DEFAULT_FONT_PATH "/home/carm/fonts/courier1.glf"
#define MAX_TOKEN_SIZE 512
#define MAX_PATH_SIZE 4096
#define STRING_BUFFER_SIZE 1024*150
#define STRING_LINE_SIZE 1024
#ifdef __unix__
#include <cstdlib>
#define projectM_isnan std::isnan
#endif
#ifdef EMSCRIPTEN
#include <cstdlib>
#define projectM_isnan isnan
#endif
#ifdef WIN32
#define projectM_isnan(x) ((x) != (x))
#endif
#ifdef __APPLE__
#define projectM_isnan(x) ((x) != (x))
#endif
#ifdef __unix__
#define projectM_fmax fmax
#endif
#ifdef WIN32
#define projectM_fmax(x,y) ((x) >= (y) ? (x): (y))
#endif
#ifdef __APPLE__
#define projectM_fmax(x,y) ((x) >= (y) ? (x): (y))
#endif
#ifdef __unix__
#define projectM_fmin fmin
#endif
#ifdef WIN32
#define projectM_fmin(x,y) ((x) <= (y) ? (x): (y))
#endif
#ifdef __APPLE__
#define projectM_fmin(x,y) ((x) <= (y) ? (x): (y))
#endif
#ifndef TRUE
#define TRUE true
#endif
#ifndef FALSE
#define FALSE false
#endif
#define MAX_DOUBLE_SIZE 10000000.0
#define MIN_DOUBLE_SIZE -10000000.0
#define MAX_INT_SIZE 10000000
#define MIN_INT_SIZE -10000000
#define DEFAULT_DOUBLE_IV 0.0
#define DEFAULT_DOUBLE_LB MIN_DOUBLE_SIZE
#define DEFAULT_DOUBLE_UB MAX_DOUBLE_SIZE
#ifdef WIN32
#include <float.h>
#define isnan _isnan
#endif /** WIN32 */
#define WIN32_PATH_SEPARATOR '\\'
#define UNIX_PATH_SEPARATOR '/'
#ifdef WIN32
#define PATH_SEPARATOR WIN32_PATH_SEPARATOR
#else
#define PATH_SEPARATOR UNIX_PATH_SEPARATOR
#endif /** WIN32 */
#include <string>
#include <algorithm>
const unsigned int NUM_Q_VARIABLES(32);
const std::string PROJECTM_FILE_EXTENSION("prjm");
const std::string MILKDROP_FILE_EXTENSION("milk");
const std::string PROJECTM_MODULE_EXTENSION("so");
template <class TraverseFunctor,class Container>
void traverse(Container & container){
TraverseFunctor functor;
for(typename Container::iterator pos=container.begin(); pos != container.end(); ++pos){
assert(pos->second);
functor(pos->second);
}}
template <class TraverseFunctor,class Container>
void traverseVector(Container & container){
TraverseFunctor functor;
for(typename Container::iterator pos=container.begin(); pos != container.end(); ++pos){
assert(*pos);
functor(*pos);
}}
template <class TraverseFunctor,class Container>
void traverse(Container & container,TraverseFunctor & functor){
for(typename Container::iterator pos=container.begin(); pos != container.end(); ++pos){
assert(pos->second);
functor(pos->second);
}}
namespace TraverseFunctors{
template <class Data>
class Delete{
public:
void operator() (Data * data){
assert(data);
delete(data);
}};}
inline std::string parseExtension(const std::string & filename){
const std::size_t start=filename.find_last_of('.');
if(start == std::string::npos || start >= (filename.length()-1))
return "";
std::string ext=filename.substr(start+1,filename.length());
std::transform(ext.begin(),ext.end(),ext.begin(),tolower);
return ext;
}
inline std::string parseFilename(const std::string & filename){
const std::size_t start=filename.find_last_of('/');
if(start == std::string::npos || start >= (filename.length()-1))
return "";
else
return filename.substr(start+1,filename.length());
}
inline double meanSquaredError(const double & x,const double & y){
return (x-y)*(x-y);
}
template <typename charT>
struct caseInsensitiveEqual{
caseInsensitiveEqual(const std::locale &loc) : loc_(loc){}
bool operator()(charT ch1,charT ch2){ return std::toupper(ch1,loc_) == std::toupper(ch2,loc_); }
private:
const std::locale &loc_;
};
template <typename T>
int caseInsensitiveSubstringFind(const T &haystack,const T &needle,const std::locale &loc=std::locale()){
typename T::const_iterator it=std::search(
haystack.begin(),haystack.end(),
needle.begin(),needle.end(),
caseInsensitiveEqual<typename T::value_type>(loc));
if(it != haystack.end()) return it - haystack.begin();
return std::string::npos;
}
enum PresetRatingType{
FIRST_RATING_TYPE=0,
HARD_CUT_RATING_TYPE=FIRST_RATING_TYPE,
SOFT_CUT_RATING_TYPE,
LAST_RATING_TYPE=SOFT_CUT_RATING_TYPE,
TOTAL_RATING_TYPES=SOFT_CUT_RATING_TYPE+1
};
typedef std::vector<int> RatingList;
#endif
