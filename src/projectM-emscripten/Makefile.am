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
	../libprojectM/KeyHandler.cpp audio.cpp \
	-o sdl-pm.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng"]' -sEXPORTED_RUNTIME_METHODS=ccall --post-js filesys.js --post-js ccall.js



run: bld
	echo 'Built sdl-pm.js.'
	
debug: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp debug.cpp \
	-o sdl-debug.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng"]' --closure 0 -sEXPORTED_RUNTIME_METHODS=ccall --post-js filesys.js --post-js ccall.js


run: debug
	echo 'Built sdl-debug.js.'
