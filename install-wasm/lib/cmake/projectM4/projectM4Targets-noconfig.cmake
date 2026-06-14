#----------------------------------------------------------------
# Generated CMake target import file.
#----------------------------------------------------------------

# Commands may need to know the format version.
set(CMAKE_IMPORT_FILE_VERSION 1)

# Import target "libprojectM::projectM" for configuration ""
set_property(TARGET libprojectM::projectM APPEND PROPERTY IMPORTED_CONFIGURATIONS NOCONFIG)
set_target_properties(libprojectM::projectM PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_NOCONFIG "C;CXX"
  IMPORTED_LOCATION_NOCONFIG "${_IMPORT_PREFIX}/lib/libprojectM-4.a"
  )

list(APPEND _cmake_import_check_targets libprojectM::projectM )
list(APPEND _cmake_import_check_files_for_libprojectM::projectM "${_IMPORT_PREFIX}/lib/libprojectM-4.a" )

# Commands beyond this point should not need to know the version.
set(CMAKE_IMPORT_FILE_VERSION)
