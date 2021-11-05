AM_CPPFLAGS = \
${my_CFLAGS} \
-I$(top_builddir)/config.h \
-I$(top_builddir)/vendor \
-DSYSCONFDIR=\""$(sysconfdir)"\" \
-I${top_srcdir}/src/libprojectM \
-I${top_srcdir}/src/libprojectM/Renderer \
${SDL_CFLAGS}

tst1: pm.cpp  Makefile.am
	em++  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp pm.cpp \
	-o gpu008.js -sPROXY_TO_PTHREAD=1 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --post-js cl-gpu.js --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js

tst3: b3.cpp Makefile.am
	emcc b3.cpp \
	-o b3003.js --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl"]' \
	-sEXPORTED_RUNTIME_METHODS=ccall --post-js cl-gpu.js --post-js b3fsys.js \
	-sUSE_SDL=2 -sPRINTF_LONG_DOUBLE=1  \
	-sFORCE_FILESYSTEM=1 -ffast-math -sSUPPORT_LONGJMP=0 -DNDEBUG \
	-sASSERTIONS=0 -sALLOW_MEMORY_GROWTH=0 -sENVIRONMENT=web \
	-sINITIAL_MEMORY=1400mb -O3 -g -sSUPPORT_BIG_ENDIAN=1 -sMEMORY64=2 -sMAXIMUM_MEMORY=4gb


all: tst1
	echo 'Built 1ink.Drop TEST.'
	
b3: tst3
	echo 'Built 1ink.Drop TEST.'
