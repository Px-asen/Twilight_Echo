cmake_minimum_required(VERSION 3.25)
if(CMAKE_SOURCE_DIR STREQUAL CMAKE_CURRENT_SOURCE_DIR)
  project(twilight_usb LANGUAGES C)
endif()
if(NOT ANDROID)
  message(FATAL_ERROR "This libusb wrapper targets Android; configure with the NDK toolchain.")
endif()

# libusb 1.0.29, using upstream's Android source list and config.h unchanged.
add_library(twilight_usb SHARED
  upstream/libusb/core.c
  upstream/libusb/descriptor.c
  upstream/libusb/hotplug.c
  upstream/libusb/io.c
  upstream/libusb/sync.c
  upstream/libusb/strerror.c
  upstream/libusb/os/linux_usbfs.c
  upstream/libusb/os/events_posix.c
  upstream/libusb/os/threads_posix.c
  upstream/libusb/os/linux_netlink.c
)
target_include_directories(twilight_usb
  PUBLIC upstream/libusb
  PRIVATE upstream/android upstream/libusb/os
)
target_compile_options(twilight_usb PRIVATE -fvisibility=hidden -pthread)
target_link_libraries(twilight_usb PRIVATE log)
target_link_options(twilight_usb PRIVATE "-Wl,-z,max-page-size=16384")
set_target_properties(twilight_usb PROPERTIES OUTPUT_NAME twilight-usb)
