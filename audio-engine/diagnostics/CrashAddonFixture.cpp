#include <windows.h>
#include <node_api.h>
namespace {
napi_value crash(napi_env, napi_callback_info) {
  RaiseException(0xC00000FF, EXCEPTION_NONCONTINUABLE, 0, nullptr);
  return nullptr;
}
napi_value initialize(napi_env env, napi_value exports) {
  napi_value callback;
  napi_create_function(env, "crash", NAPI_AUTO_LENGTH, crash, nullptr, &callback);
  napi_set_named_property(env, exports, "crash", callback);
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
