AM_CPPFLAGS = \
${my_CFLAGS} \
-I$(top_builddir)/config.h \
-I$(top_builddir)/vendor \
-DSYSCONFDIR=\""$(sysconfdir)"\" \
-I${top_srcdir}/src/libprojectM \
-I${top_srcdir}/src/libprojectM/Renderer \
${SDL_CFLAGS}

tst1: pm.cpp  Makefile.am
	emcc $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp pm.cpp \
	-o gpu011.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck","_b3"]' -sEXPORTED_RUNTIME_METHODS=ccall 
	--post-js filesys.js --post-js ccall.js

tst2: safe.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp safe.cpp \
	-o safe.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js \
	cl-gpu.js --post-js filesys.js --post-js ccall.js


tst3: b3NoSDL.cpp Makefile.am
	emcc b3NoSDL.cpp \
	 -o b3007.js --closure 0 \
	 -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js cl-gpu.js --post-js b3fsys.js \
	 -sENVIRONMENT=web -sFORCE_FILESYSTEM=1 -ffast-math \
	 -sMAXIMUM_MEMORY=4GB -sALLOW_MEMORY_GROWTH=1 
	 -sINITIAL_MEMORY=2400mb -O2 -flto=thin -sFULL_ES3=1
         -DNDEBUG -sSUPPORT_ERRNO=0 -sGL_DEBUG=0 -sGL_TRACK_ERRORS=0 \
	 -sGL_POOL_TEMP_BUFFERS=0 -sMEMORY64=0 -sLEGALIZE_JS_FFI=0 -sWASM_BIGINT=1

tst: tst1
	echo 'Built 1ink.Drop TEST.'
	
b3: tst3
	echo 'Built 1ink.Drop TEST.'
	
all: b3 tst1 tst2
	echo 'Built all 1ink.Drop tests.'
