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
	-o 1inkDrop-egl6.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js index.js --post-js filesys.js --post-js preinit.js

bld2: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp egl4.cpp \
	-o 1inkDrop-egl6a.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --post-js preinit.js --post-js filesys.js  --extern-post-js index.js

bld3: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp egl5.cpp \
	-o 1inkDrop-egl6b.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --post-js filesys.js  --extern-post-js index.js

bld4: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp egl6.cpp \
	-o 1inkDrop-egl6c.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --post-js filesys.js  --extern-post-js index.js

run: bld
	echo 'Build 1inkDrop.'

test: bld2 bld3 bld4
	echo '/n put 1inkDrop-egl5a.js /n put1inkDrop-egl5a.wasm /n put 1inkDrop-egl5b.js /n put1inkDrop-egl5b.wasm /n put 1inkDrop-egl5c.js /n put1inkDrop-egl5c.wasm /n /n'
