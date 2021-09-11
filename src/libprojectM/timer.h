#ifndef _TIMER_H
#define _TIMER_H
#ifndef WIN32
#include <sys/time.h>
unsigned int getTicks( struct timeval *start );
extern "C" {
typedef int (*fspec_gettimeofday)(struct timeval *tv, struct timezone *tz);
int projectm_gettimeofday(struct timeval *tv, struct timezone *tz);
extern  fspec_gettimeofday pprojectm_gettimeofday;
}
struct timeval GetCurrentTime();
#else
#include <windows.h>
unsigned int getTicks( long start );
#endif /** !WIN32 */
#endif /** _TIMER_H */
