cmake_minimum_required(VERSION 3.25)
project(TwilightEbur128 LANGUAGES C)

# libebur128 1.2.6, commit 67b33abe1558160ed76ada1322329b0e9e058b02.
# Keep upstream source untouched and isolate its build from global CMake options.
add_library(twilight_ebur128 STATIC upstream/ebur128/ebur128.c)
set_target_properties(twilight_ebur128 PROPERTIES
  C_STANDARD 99
  C_STANDARD_REQUIRED ON
  POSITION_INDEPENDENT_CODE ON
  C_VISIBILITY_PRESET hidden
)
target_include_directories(twilight_ebur128
  PUBLIC upstream/ebur128
  PRIVATE upstream/ebur128/queue
)
if(UNIX)
  target_link_libraries(twilight_ebur128 PRIVATE m)
endif()
