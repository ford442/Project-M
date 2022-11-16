AM_CPPFLAGS = \
${my_CFLAGS} \
-I$(top_builddir)/config.h \
-I$(top_builddir)/vendor \
-DSYSCONFDIR=\""$(sysconfdir)"\" \
-I${top_srcdir}/src/libprojectM \
-I${top_srcdir}/src/libprojectM/Renderer \
${SDL_CFLAGS}

wasm:
	em++ $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp october.cpp \
	-o gpu012.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck","_b3"]' -sEXPORTED_RUNTIME_METHODS=ccall \
	--extern-post-js filesys.js --extern-post-js ccall.js

all: wasm
	echo 'Built 1ink.Drop TEST.'

