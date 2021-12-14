AM_CPPFLAGS = \
${my_CFLAGS} \
-I$(top_builddir)/config.h \
-I$(top_builddir)/vendor \
-DSYSCONFDIR=\""$(sysconfdir)"\" \
-I${top_srcdir}/src/libprojectM \
-I${top_srcdir}/src/libprojectM/Renderer \
${SDL_CFLAGS}

tst1: pm.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp pm.cpp \
	-o gpu010.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js cl-gpu.js --extern-post-js index.js --post-js filesys.js --post-js ccall.js

tst2: safe.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp safe.cpp \
	-o safe.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js cl-gpu.js --extern-post-js index.js --post-js filesys.js --post-js ccall.js


tst3: b3.cpp Makefile.am
	emcc b3.cpp \
	-o b3006.js --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl"]' \
	-sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js cl-gpu.js --post-js b3fsys.js \
	-sUSE_SDL=2 -sPRINTF_LONG_DOUBLE=1 -sENVIRONMENT=web \
	-sFORCE_FILESYSTEM=1 -ffast-math -sSUPPORT_LONGJMP=0 -DNDEBUG \
	-sALLOW_MEMORY_GROWTH=0 -g -sFULL_ES2=1 -sFULL_ES3=1 -sGL_TESTING=1 -sINITIAL_MEMORY=1400mb -O3 -flto=thin -sSUPPORT_BIG_ENDIAN=0


tst: tst1
	echo 'Built 1ink.Drop TEST.'
	
b3: tst3
	echo 'Built 1ink.Drop TEST.'
	
all: b3 tst1 tst2
	echo 'Built all 1ink.Drop tests.'
