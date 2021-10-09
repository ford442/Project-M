AM_CPPFLAGS = \
${my_CFLAGS} \
-I$(top_builddir)/config.h \
-I$(top_builddir)/vendor \
-DSYSCONFDIR=\""$(sysconfdir)"\" \
-I${top_srcdir}/src/libprojectM \
-I${top_srcdir}/src/libprojectM/Renderer \
${SDL_CFLAGS}

bld1: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 19a.js --closure 0 --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld2: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 19b.js -sUSE_SDL=2 --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld3: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 19c.js -sUSE_SDL=2 --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld4: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 19d.js -sUSE_SDL=2 --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld5:  lazuli.cpp Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 19e.js -sUSE_SDL=2 -sLEGACY_GL_EMULATION=1 -sGL_UNSAFE_OPTS=1 --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

tst1:   lazuli.cpp Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 24t.js -sUSE_REGAL=0 -sUSE_SDL=2 --closure 1 -g0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

tst2: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o lazuli.js -sUSE_REGAL=1 -sUSE_SDL=2 --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

tst3: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o lazuliES.js -sUSE_REGAL=1 -sFULL_ES3=1 -sUSE_SDL=2 --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

tst4: b3lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp b3lazuli.cpp \
	-o b3lz.js --closure 0 --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js

tst5: bpp.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp bpp.cpp \
	-o bpp.js -sUSE_REGAL=1 -sUSE_SDL=2 --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js

tst6: bpp16.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp bpp16.cpp \
	-o bpp16.js -sUSE_REGAL=1 -sUSE_SDL=2 --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js


run: bld1 bld2 bld3 bld4 bld5
	echo 'Built 1ink.Drop 19 (a - e).'
	
test: tst1 tst2 tst3
	echo 'Built 1ink.Drop TEST.'
	
testnc: tst2 tst3
	echo 'Built 1ink.Drop TEST.'
	
testb3: tst4
	echo 'Built 1ink.Drop TEST.'
	
bpp: tst5
	echo 'Built 1ink.Drop TEST.'
	
bpp16: tst6
	echo 'Built 1ink.Drop TEST.'

