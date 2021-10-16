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
	-o gpu003.js --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --post-js cl-gpu.js --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js

tst1: b3lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp safe.cpp \
	-o gpu003s.js --closure 0 -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall -sFULL_ES2 --post-js cl-gpu.js --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js


all: tst1
	echo 'Built 1ink.Drop TEST.'
