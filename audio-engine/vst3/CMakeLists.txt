cmake_minimum_required(VERSION 3.25)

project(TwilightVst3Helpers VERSION 0.1.0 LANGUAGES CXX)
if(MSVC)
  add_compile_options(/Zi)
  add_link_options(/DEBUG)
endif()

if(NOT WIN32)
  message(FATAL_ERROR "Twilight VST3 helpers are supported only on Windows x64.")
endif()

if(NOT MSVC)
  message(FATAL_ERROR "Twilight VST3 helpers must be built with MSVC to match Windows VST3 modules.")
endif()

set(TAE_VST3_SDK_ROOT "$ENV{TAE_VST3_SDK_ROOT}" CACHE PATH "Root of the fixed Steinberg VST3 SDK")
if(NOT TAE_VST3_SDK_ROOT)
  message(FATAL_ERROR "TAE_VST3_SDK_ROOT is required.")
endif()
cmake_path(ABSOLUTE_PATH TAE_VST3_SDK_ROOT NORMALIZE OUTPUT_VARIABLE TAE_VST3_SDK_ROOT)

set(_tae_vst3_required_files
  "${TAE_VST3_SDK_ROOT}/CMakeLists.txt"
  "${TAE_VST3_SDK_ROOT}/cmake/modules/SMTG_VST3_SDK.cmake"
  "${TAE_VST3_SDK_ROOT}/pluginterfaces/vst/ivstaudioprocessor.h"
  "${TAE_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module.h"
)
foreach(_tae_vst3_file IN LISTS _tae_vst3_required_files)
  if(NOT EXISTS "${_tae_vst3_file}")
    message(FATAL_ERROR "TAE_VST3_SDK_ROOT is incomplete: ${_tae_vst3_file}")
  endif()
endforeach()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# Steinberg's preconfigured SDK libraries use the dynamic MSVC runtime. The
# packaged helpers stage the matching Microsoft runtime beside the executables.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL" CACHE STRING "" FORCE)

set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_WAYLAND_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_AUV2_BUILDS OFF CACHE BOOL "" FORCE)

add_subdirectory("${TAE_VST3_SDK_ROOT}" vst3sdk EXCLUDE_FROM_ALL)

add_library(twilight_vst3_probe STATIC
  Vst3ModuleProbe.cpp
  "${TAE_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp"
  "${TAE_VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp"
)
target_include_directories(twilight_vst3_probe PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
target_link_libraries(twilight_vst3_probe PUBLIC sdk_hosting)
target_compile_definitions(twilight_vst3_probe PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(twilight_vst3_probe PRIVATE /W4 /permissive- /EHsc)

add_executable(twilight_vst3_scanner ScannerMain.cpp)
target_link_libraries(twilight_vst3_scanner PRIVATE twilight_vst3_probe)
target_compile_definitions(twilight_vst3_scanner PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(twilight_vst3_scanner PRIVATE /W4 /permissive- /EHsc)
set_target_properties(twilight_vst3_scanner PROPERTIES OUTPUT_NAME "twilight-vst3-scanner")

add_executable(twilight_vst3_host
  HostMain.cpp
  Vst3Runtime.cpp
  "${TAE_VST3_SDK_ROOT}/public.sdk/source/vst/vstpresetfile.cpp"
)
target_link_libraries(twilight_vst3_host PRIVATE twilight_vst3_probe)
target_compile_definitions(twilight_vst3_host PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(twilight_vst3_host PRIVATE /W4 /permissive- /EHsc)
set_target_properties(twilight_vst3_host PROPERTIES OUTPUT_NAME "twilight-vst3-host")

foreach(_tae_target IN ITEMS twilight_vst3_scanner twilight_vst3_host)
  set_target_properties(${_tae_target} PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin/Debug"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin/Release"
    RUNTIME_OUTPUT_DIRECTORY_RELWITHDEBINFO "${CMAKE_BINARY_DIR}/bin/RelWithDebInfo"
    RUNTIME_OUTPUT_DIRECTORY_MINSIZEREL "${CMAKE_BINARY_DIR}/bin/MinSizeRel"
  )
endforeach()

enable_testing()
add_test(NAME twilight_vst3_scanner_selftest COMMAND $<TARGET_FILE:twilight_vst3_scanner> --self-test)
add_test(NAME twilight_vst3_host_selftest COMMAND $<TARGET_FILE:twilight_vst3_host> --self-test)

message(STATUS "Twilight VST3 helpers: Windows x64 MSVC")
message(STATUS "  SDK root: ${TAE_VST3_SDK_ROOT}")
message(STATUS "  SDK plugin examples: ${SMTG_ENABLE_VST3_PLUGIN_EXAMPLES}")
message(STATUS "  SDK VSTGUI: ${SMTG_ENABLE_VSTGUI_SUPPORT}")
