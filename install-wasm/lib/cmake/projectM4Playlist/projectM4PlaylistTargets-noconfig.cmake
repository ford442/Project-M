#----------------------------------------------------------------
# Generated CMake target import file.
#----------------------------------------------------------------

# Commands may need to know the format version.
set(CMAKE_IMPORT_FILE_VERSION 1)

# Import target "libprojectM::playlist" for configuration ""
set_property(TARGET libprojectM::playlist APPEND PROPERTY IMPORTED_CONFIGURATIONS NOCONFIG)
set_target_properties(libprojectM::playlist PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_NOCONFIG "CXX"
  IMPORTED_LOCATION_NOCONFIG "${_IMPORT_PREFIX}/lib/libprojectM-4-playlist.a"
  )

list(APPEND _cmake_import_check_targets libprojectM::playlist )
list(APPEND _cmake_import_check_files_for_libprojectM::playlist "${_IMPORT_PREFIX}/lib/libprojectM-4-playlist.a" )

# Commands beyond this point should not need to know the version.
set(CMAKE_IMPORT_FILE_VERSION)
