AM_CPPFLAGS = \
${my_CFLAGS} \
-I$(top_builddir)/config.h \
-I$(top_builddir)/vendor \
-DSYSCONFDIR=\""$(sysconfdir)"\" \
-I${top_srcdir}/src/libprojectM \
-I${top_srcdir}/src/libprojectM/Renderer \
${SDL_CFLAGS}

tst1: b3lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp b3lazuli.cpp \
	-o gpu003a.js -sFULL_ES2=1 --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --post-js cl-gpu.js --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js

tst2: b3lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp safe.cpp \
	-o gpu003sa.js --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall -sFULL_ES3 --post-js cl-gpu.js --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js

tst3:  b3.cpp Makefile.am
	emcc b3.cpp -sFORCE_FILESYSTEM=1 -sUSE_SDL=2 -sPRINTF_LONG_DOUBLE=1 -ffast-math -flto=thin -sSUPPORT_LONGJMP=0 -DNDEBUG -sASSERTIONS=0 -sALLOW_MEMORY_GROWTH=0 -sMALLOC="emmalloc" -sENVIRONMENT=web -sINITIAL_MEMORY=1400mb -O3 -o gpub3.js --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl"]' -sEXPORTED_RUNTIME_METHODS=ccall --post-js cl-gpu.js --post-js b3fsys.js

all: tst1 tst3
	echo 'Built 1ink.Drop TEST.'
	
b3: tst3
	echo 'Built 1ink.Drop TEST.'
