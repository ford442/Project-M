cmake_minimum_required(VERSION 3.21 FATAL_ERROR)

option(ENABLE_BOOST_FILESYSTEM "Force the use of boost::filesystem, even if the compiler supports C++17." OFF)

if(ENABLE_BOOST_FILESYSTEM)
    list(APPEND VCPKG_MANIFEST_FEATURES boost-filesystem)
endif()

project(projectM_CXX_Test
        LANGUAGES C CXX
        )

# The installed ProjectM.hpp uses std::optional, so a consumer needs C++17 or newer. The installed
# target also exports cxx_std_20 as an INTERFACE compile feature (src/libprojectM/CMakeLists.txt), and
# the check below fails if it goes missing. Setting the standard here as well keeps MSVC, whose default
# is C++14, from failing on the header before that check is ever reached.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(projectM4 REQUIRED)

get_target_property(_projectm_features libprojectM::projectM INTERFACE_COMPILE_FEATURES)
if(NOT _projectm_features OR NOT "cxx_std_20" IN_LIST _projectm_features)
    message(FATAL_ERROR "The installed libprojectM::projectM target must export the cxx_std_20 compile feature "
            "(ENABLE_CXX_INTERFACE headers use C++17/20 library types); INTERFACE_COMPILE_FEATURES is '${_projectm_features}'.")
endif()

add_executable(projectM4_CXX_Test
        main.cpp
        )

target_link_libraries(projectM4_CXX_Test
        libprojectM::projectM
        )
