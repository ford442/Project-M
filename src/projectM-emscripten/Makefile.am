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
	-sFULL_ES2=1 -sFULL_ES3=1  -sFORCE_FILESYSTEM=1 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=1400mb -O3 \
	-sNO_EXIT_RUNTIME=1 --extern-post-js filesys.js --extern-post-js ccall.js

all: wasm
	echo 'Built 1ink.Drop TEST.'

