# Shared by the x64 engine and the standalone MSVC Win32 helper.
set(TAE_ASIO_ENGINE_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../..")

function(tae_add_asio_helper target)
  add_executable(${target}
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/helper/AsioHelperMain.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/helper/AsioHelperServer.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/AsioFormatSupport.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/DeviceCapabilityCache.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/RealAsioHost.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/windows/AsioCallbackRouter.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/windows/AsioControlThread.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/windows/AsioDriverCatalog.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/output/asio/windows/AsioDriverSession.cpp"
    "${TAE_ASIO_ENGINE_ROOT}/core/AudioTypes.cpp"
  )
  target_include_directories(${target} PRIVATE "${TAE_ASIO_ENGINE_ROOT}")
  target_compile_definitions(${target} PRIVATE TAE_ENABLE_ASIO=1 TAE_ASIO_HELPER_PROCESS=1 WIN32_LEAN_AND_MEAN NOMINMAX)
  target_link_libraries(${target} PRIVATE ole32 uuid advapi32 user32)
  if(MINGW)
    target_link_options(${target} PRIVATE -municode "$<$<NOT:$<CONFIG:Debug>>:-Wl,--strip-debug>")
  endif()
  if(CMAKE_SIZEOF_VOID_P EQUAL 4)
    set_target_properties(${target} PROPERTIES OUTPUT_NAME "twilight-asio-helper-x86")
  else()
    set_target_properties(${target} PROPERTIES OUTPUT_NAME "twilight-asio-helper")
  endif()
endfunction()
