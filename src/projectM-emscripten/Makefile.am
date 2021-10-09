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
	-o 19b.js --closure 0 --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld3: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 19c.js --closure 0  --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld4: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 19d.js --closure 0  --extern-post-js index.js --post-js filesys.js --post-js ccall.js

bld5:  lazuli.cpp Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 19e.js --closure 0  --extern-post-js index.js --post-js filesys.js --post-js ccall.js

tst1:   lazuli.cpp Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o 24t.js --closure 1 -g0  --extern-post-js index.js --post-js filesys.js --post-js ccall.js

tst2: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o lazuli.js --closure 0  --extern-post-js index.js --post-js filesys.js --post-js ccall.js

tst3: lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp lazuli.cpp \
	-o lazuliES.js --closure 0  --extern-post-js index.js --post-js filesys.js --post-js ccall.js

tst4: b3lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp b3lazuli.cpp \
	-o b3lz.js -sMEMORY64=2 -sGL_TRACK_ERRORS=0 -sGL_EXPLICIT_UNIFORM_LOCATION=1 \ 
	-sWASMFS=1 -sDISABLE_DEPRECATED_FIND_EVENT_TARGET_BEHAVIOR=0 -sAUTO_JS_LIBRARIES=0 \ 
	-sAUTO_NATIVE_LIBRARIES=0 -sMALLOC='emmalloc' -sGL_MAX_TEMP_BUFFER_SIZE=1024mb \
	--closure 0 --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js \
	-sINITIAL_MEMORY=384mb
	
tstz: b3lazuli.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp b3lazuli.cpp \
	-o b3lzz.js -sMEMORY64=2 -sGL_TRACK_ERRORS=0 -sGL_TESTING=1 -sGL_EXPLICIT_UNIFORM_LOCATION=1 \
	-sWEBGL2_BACKWARDS_COMPATIBILITY_EMULATION=1 -sLEGACY_GL_EMULATION=1 -sUSE_WEBGPU=1 -sWASMFS=1 \
	-sDISABLE_DEPRECATED_FIND_EVENT_TARGET_BEHAVIOR=0 -sAUTO_JS_LIBRARIES=0 -sAUTO_NATIVE_LIBRARIES=0 \
	-sMALLOC='emmalloc-memvalidate' -sGL_MAX_TEMP_BUFFER_SIZE=2048mb -sFULL_ES3 -sUSE_REGAL=1 --closure 0 \
        --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js \
	-sINITIAL_MEMORY=256mb

tst5: bpp.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp bpp.cpp \
	-o bpp.js --closure 0  --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js

tst6: bpp16.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp bpp16.cpp \
	-o bpp16.js --closure 0  --extern-post-js index.js --post-js b3filesys.js --post-js ccall.js


run: bld1 bld2 bld3 bld4 bld5
	echo 'Built 1ink.Drop 19 (a - e).'
	
test: tst1 tst2 tst3
	echo 'Built 1ink.Drop TEST.'
	
testnc: tst2 tst3
	echo 'Built 1ink.Drop TEST.'
	
testb3: tst4 tstz
	echo 'Built 1ink.Drop TEST.'
	
bpp: tst5
	echo 'Built 1ink.Drop TEST.'
	
bpp16: tst6
	echo 'Built 1ink.Drop TEST.'

