#if defined(_WIN32)

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>

#include <node_api.h>

namespace {

FARPROC resolveNodeApiSymbol(const char* name) {
  if (!name) return nullptr;

  if (HMODULE currentProcess = GetModuleHandleW(nullptr)) {
    if (FARPROC proc = GetProcAddress(currentProcess, name)) return proc;
  }

  const wchar_t* fallbackModules[] = {
      L"node.dll",
      L"node.exe",
      L"electron.exe",
  };
  for (const wchar_t* moduleName : fallbackModules) {
    if (HMODULE module = GetModuleHandleW(moduleName)) {
      if (FARPROC proc = GetProcAddress(module, name)) return proc;
    }
  }

  return nullptr;
}

template <typename Fn>
Fn loadNodeApi(const char* name) {
  return reinterpret_cast<Fn>(resolveNodeApiSymbol(name));
}

}  // namespace

extern "C" napi_status NAPI_CDECL napi_get_undefined(napi_env env, napi_value* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_value*);
  static Fn fn = loadNodeApi<Fn>("napi_get_undefined");
  return fn ? fn(env, result) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_get_boolean(napi_env env, bool value, napi_value* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, bool, napi_value*);
  static Fn fn = loadNodeApi<Fn>("napi_get_boolean");
  return fn ? fn(env, value, result) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_create_array_with_length(
    napi_env env,
    size_t length,
    napi_value* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, size_t, napi_value*);
  static Fn fn = loadNodeApi<Fn>("napi_create_array_with_length");
  return fn ? fn(env, length, result) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_create_double(napi_env env, double value, napi_value* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, double, napi_value*);
  static Fn fn = loadNodeApi<Fn>("napi_create_double");
  return fn ? fn(env, value, result) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_create_function(
    napi_env env,
    const char* utf8name,
    size_t length,
    napi_callback cb,
    void* data,
    napi_value* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
  static Fn fn = loadNodeApi<Fn>("napi_create_function");
  return fn ? fn(env, utf8name, length, cb, data, result) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_create_string_utf8(
    napi_env env,
    const char* str,
    size_t length,
    napi_value* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, const char*, size_t, napi_value*);
  static Fn fn = loadNodeApi<Fn>("napi_create_string_utf8");
  return fn ? fn(env, str, length, result) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_get_cb_info(
    napi_env env,
    napi_callback_info cbinfo,
    size_t* argc,
    napi_value* argv,
    napi_value* thisArg,
    void** data) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
  static Fn fn = loadNodeApi<Fn>("napi_get_cb_info");
  return fn ? fn(env, cbinfo, argc, argv, thisArg, data) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_get_value_double(
    napi_env env,
    napi_value value,
    double* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_value, double*);
  static Fn fn = loadNodeApi<Fn>("napi_get_value_double");
  return fn ? fn(env, value, result) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_get_value_bool(
    napi_env env,
    napi_value value,
    bool* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_value, bool*);
  static Fn fn = loadNodeApi<Fn>("napi_get_value_bool");
  return fn ? fn(env, value, result) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_get_value_string_utf8(
    napi_env env,
    napi_value value,
    char* buffer,
    size_t bufferSize,
    size_t* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_value, char*, size_t, size_t*);
  static Fn fn = loadNodeApi<Fn>("napi_get_value_string_utf8");
  return fn ? fn(env, value, buffer, bufferSize, result) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_set_element(
    napi_env env,
    napi_value object,
    uint32_t index,
    napi_value value) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_value, uint32_t, napi_value);
  static Fn fn = loadNodeApi<Fn>("napi_set_element");
  return fn ? fn(env, object, index, value) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_set_named_property(
    napi_env env,
    napi_value object,
    const char* utf8name,
    napi_value value) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_value, const char*, napi_value);
  static Fn fn = loadNodeApi<Fn>("napi_set_named_property");
  return fn ? fn(env, object, utf8name, value) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_throw_error(napi_env env, const char* code, const char* msg) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, const char*, const char*);
  static Fn fn = loadNodeApi<Fn>("napi_throw_error");
  return fn ? fn(env, code, msg) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_throw_type_error(napi_env env, const char* code, const char* msg) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, const char*, const char*);
  static Fn fn = loadNodeApi<Fn>("napi_throw_type_error");
  return fn ? fn(env, code, msg) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_add_env_cleanup_hook(
    node_api_basic_env env,
    napi_cleanup_hook fun,
    void* arg) {
  using Fn = napi_status(NAPI_CDECL*)(node_api_basic_env, napi_cleanup_hook, void*);
  static Fn fn = loadNodeApi<Fn>("napi_add_env_cleanup_hook");
  return fn ? fn(env, fun, arg) : napi_generic_failure;
}

extern "C" napi_status NAPI_CDECL napi_throw_range_error(napi_env env, const char* code, const char* msg) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, const char*, const char*);
  static Fn fn = loadNodeApi<Fn>("napi_throw_range_error");
  return fn ? fn(env, code, msg) : napi_generic_failure;
}
extern "C" napi_status NAPI_CDECL napi_create_object(napi_env env, napi_value* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_value*);
  static Fn fn = loadNodeApi<Fn>("napi_create_object");
  return fn ? fn(env, result) : napi_generic_failure;
}
extern "C" napi_status NAPI_CDECL napi_is_buffer(napi_env env, napi_value value, bool* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_value, bool*);
  static Fn fn = loadNodeApi<Fn>("napi_is_buffer");
  return fn ? fn(env, value, result) : napi_generic_failure;
}
extern "C" napi_status NAPI_CDECL napi_get_buffer_info(napi_env env, napi_value value, void** data, size_t* length) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, napi_value, void**, size_t*);
  static Fn fn = loadNodeApi<Fn>("napi_get_buffer_info");
  return fn ? fn(env, value, data, length) : napi_generic_failure;
}
extern "C" napi_status NAPI_CDECL napi_create_buffer_copy(napi_env env, size_t length, const void* data, void** copy, napi_value* result) {
  using Fn = napi_status(NAPI_CDECL*)(napi_env, size_t, const void*, void**, napi_value*);
  static Fn fn = loadNodeApi<Fn>("napi_create_buffer_copy");
  return fn ? fn(env, length, data, copy, result) : napi_generic_failure;
}
#endif  // defined(_WIN32)
