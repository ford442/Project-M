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
	-o wav.js -sEXPORTED_FUNCTIONS='["_chng"]' -sEXPORTED_RUNTIME_METHODS=ccall

run: projectW.html
	echo 'Built wav.js.'
