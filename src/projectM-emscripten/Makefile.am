AM_CPPFLAGS = \
${my_CFLAGS} \
-I$(top_builddir)/config.h \
-I$(top_builddir)/vendor \
-DSYSCONFDIR=\""$(sysconfdir)"\" \
-I${top_srcdir}/src/libprojectM \
-I${top_srcdir}/src/libprojectM/Renderer \
${SDL_CFLAGS}


projectW.html: projectM_SDL_emscripten.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp wav.cpp \
	-o wavx.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng"]' -sEXPORTED_RUNTIME_METHODS=ccall --pre-js filesys.js --extern-post-js ccall.js

run: projectW.html
	echo 'Built wavx.js.'
