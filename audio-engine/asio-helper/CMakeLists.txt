cmake_minimum_required(VERSION 3.25)
project(TwilightAsioHelper LANGUAGES CXX)
if(MSVC)
  add_compile_options(/Zi)
  add_link_options(/DEBUG)
endif()

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "The standalone ASIO helper requires MSVC on Windows")
endif()
set(TAE_ASIO_HELPER_ARCH "" CACHE STRING "Expected helper architecture (x86 or x64)")
if((TAE_ASIO_HELPER_ARCH STREQUAL "x86" AND NOT CMAKE_SIZEOF_VOID_P EQUAL 4) OR
   (TAE_ASIO_HELPER_ARCH STREQUAL "x64" AND NOT CMAKE_SIZEOF_VOID_P EQUAL 8))
  message(FATAL_ERROR "ASIO helper compiler architecture does not match ${TAE_ASIO_HELPER_ARCH}; use a separate build directory")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_options(/utf-8 /UNDEBUG)
add_compile_definitions(WIN32_LEAN_AND_MEAN NOMINMAX TAE_ENABLE_ASIO=1)
include(../output/asio/helper/AsioHelperTargets.cmake)
include_directories("${TAE_ASIO_ENGINE_ROOT}")
tae_add_asio_helper(twilight_asio_helper)

option(TAE_BUILD_TESTS "Build ASIO bridge validation fixtures" ON)
if(TAE_BUILD_TESTS)
  enable_testing()
  add_executable(twilight_asio_abi_checks "${TAE_ASIO_ENGINE_ROOT}/output/asio/abi/AsioAbiChecks.cpp")
  add_executable(twilight_asio_abi_manifest "${TAE_ASIO_ENGINE_ROOT}/output/asio/abi/AsioAbiManifest.cpp")
  add_executable(twilight_asio_helper_layout "${TAE_ASIO_ENGINE_ROOT}/output/asio/helper/AsioHelperLayout.cpp")
  add_library(twilight_asio_fake_driver SHARED "${TAE_ASIO_ENGINE_ROOT}/tests/asio-abi-fixture/FakeAsioDriver.cpp")
  add_executable(twilight_asio_abi_cross_dll_tests "${TAE_ASIO_ENGINE_ROOT}/tests/asio_abi_cross_dll_tests.cpp")
  target_link_libraries(twilight_asio_abi_cross_dll_tests PRIVATE ole32 uuid)
  add_test(NAME asio_abi_checks COMMAND twilight_asio_abi_checks)
  add_test(NAME asio_driver_abi COMMAND twilight_asio_abi_cross_dll_tests)
  set_tests_properties(asio_driver_abi PROPERTIES ENVIRONMENT "TAE_ASIO_FAKE_DRIVER_PATH=$<TARGET_FILE:twilight_asio_fake_driver>")
  add_test(NAME asio_helper_selftest COMMAND twilight_asio_helper --self-test)

  add_executable(twilight_asio_helper_fixture
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/helper/AsioHelperFixture.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/helper/AsioHelperServer.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/core/AudioTypes.cpp")
  target_link_libraries(twilight_asio_helper_fixture PRIVATE user32)
  set_target_properties(twilight_asio_helper_fixture PROPERTIES OUTPUT_NAME "twilight-asio-helper-fixture")
  add_executable(twilight_asio_helper_parent_fixture
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/helper/AsioHelperParentFixture.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/helper/AsioHelperProcess.cpp")
  target_link_libraries(twilight_asio_helper_parent_fixture PRIVATE user32)
  set_target_properties(twilight_asio_helper_parent_fixture PROPERTIES OUTPUT_NAME "twilight-asio-helper-parent-fixture")
  add_executable(twilight_asio_helper_process_tests
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/helper/AsioHelperProcess.test.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/helper/AsioHelperProcess.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/AsioHelperHost.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/DeviceCapabilityCache.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/windows/AsioDriverCatalog.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/core/AudioTypes.cpp")
  target_link_libraries(twilight_asio_helper_process_tests PRIVATE user32 advapi32 ole32)
  add_test(NAME asio_helper_process COMMAND twilight_asio_helper_process_tests
    $<TARGET_FILE:twilight_asio_helper_fixture> $<TARGET_FILE:twilight_asio_helper_parent_fixture>)
  set_tests_properties(asio_helper_process PROPERTIES TIMEOUT 60)
endif()
