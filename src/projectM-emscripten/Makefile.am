AM_CPPFLAGS = \
${my_CFLAGS} \
-I$(top_builddir)/config.h \
-I$(top_builddir)/vendor \
-DSYSCONFDIR=\""$(sysconfdir)"\" \
-I${top_srcdir}/src/libprojectM \
-I${top_srcdir}/src/libprojectM/Renderer \
${SDL_CFLAGS}

bld: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp audio3.cpp \
	-o 1inkDrop-egl17a.js --closure 1 -g0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld2: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp audio4.cpp \
	-o 1inkDrop-egl17b.js --closure 1 -g0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld3: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp egl2.cpp \
	-o 1inkDrop-egl17c.js --closure 1 -g0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld4: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp egl3.cpp \
	-o 1inkDrop-egl17d.js --closure 1 -g0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld5: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp egl2.cpp \
	-o 1inkDrop-egl17e.js -sLEGACY_GL_EMULATION=1 -sGL_UNSAFE_OPTS=1 --closure 1 -g0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld6: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp egl2.cpp \
	-o pm18tst.js --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js ccall.js

run: bld bld2 bld3 bld4 bld5
	echo 'Built 1inkDrop-egl17.'
	
try: bld6
	echo 'Built pm18tst.js  pm18tst.wasm'

