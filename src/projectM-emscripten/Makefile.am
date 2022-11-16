AM_CPPFLAGS = \
${my_CFLAGS} \
-I$(top_builddir)/config.h \
-I$(top_builddir)/vendor \
-DSYSCONFDIR=\""$(sysconfdir)"\" \
-I${top_srcdir}/src/libprojectM \
-I${top_srcdir}/src/libprojectM/Renderer \


tst1:
	emcc $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp october.cpp \
	-o gpu012.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck","_b3"]' -sEXPORTED_RUNTIME_METHODS=ccall 
	--extern-post-js filesys.js --extern-post-js ccall.js

tst2: safe.cpp  Makefile.am
	emcc  $(EMSCRIPTEN_FLAGS) $(AM_CPPFLAGS) ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp safe.cpp \
	-o safe.js -sEXPORTED_FUNCTIONS='["_main","_pl","_chng","_swtch","_lck"]' -sEXPORTED_RUNTIME_METHODS=ccall \
	--extern-pre-js cl-gpu.js --extern-post-js filesys.js --extern-post-js ccall.js


tst3: b3NoSDL.cpp Makefile.am
	emcc ${top_srcdir}/src/libprojectM/.libs/libprojectM.a \
	../libprojectM/KeyHandler.cpp b3NoSDL.cpp \
	 -o b3007.js --closure 0 \
	 -sEXPORTED_RUNTIME_METHODS=ccall --extern-post-js cl-gpu.js --post-js b3fsys.js \
	 -sENVIRONMENT=web -sFORCE_FILESYSTEM=1 \
	  -sALLOW_MEMORY_GROWTH=1 
	 -sINITIAL_MEMORY=1400mb -O2 -flto=thin -sFULL_ES3=1 -sFULL_ES2=1

tst: tst1
	echo 'Built 1ink.Drop TEST.'
	
b3: tst3
	echo 'Built 1ink.Drop TEST.'
	
all: b3 tst1 tst2
	echo 'Built all 1ink.Drop tests.'
