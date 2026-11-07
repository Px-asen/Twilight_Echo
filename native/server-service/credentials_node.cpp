#include <windows.h>
#include <wincrypt.h>
#include <node_api.h>
#include <string>

namespace {
napi_value transform(napi_env env, napi_callback_info info, bool encrypt) {
  size_t count = 2;
  napi_value args[2]{};
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 2) {
    napi_throw_type_error(env, nullptr, "Credential data and scope are required"); return nullptr;
  }
  DATA_BLOB input{}, entropy{}, output{};
  DATA_BLOB* blobs[] = {&input, &entropy};
  for (size_t i = 0; i < 2; ++i) {
    bool buffer = false; void* data = nullptr; size_t length = 0;
    if (napi_is_buffer(env, args[i], &buffer) != napi_ok || !buffer ||
        napi_get_buffer_info(env, args[i], &data, &length) != napi_ok ||
        length == 0 || length > (i == 0 ? 1024u * 1024u : 16384u)) {
      napi_throw_type_error(env, nullptr, "Invalid credential data or scope"); return nullptr;
    }
    blobs[i]->pbData = static_cast<BYTE*>(data); blobs[i]->cbData = static_cast<DWORD>(length);
  }
  const BOOL ok = encrypt
      ? CryptProtectData(&input, L"Twilight Echo Server", &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)
      : CryptUnprotectData(&input, nullptr, &entropy, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output);
  if (!ok) {
    const std::string message = "Windows credential protection failed (" + std::to_string(GetLastError()) + ")";
    napi_throw_error(env, nullptr, message.c_str()); return nullptr;
  }
  napi_value result = nullptr;
  const auto status = napi_create_buffer_copy(env, output.cbData, output.pbData, nullptr, &result);
  SecureZeroMemory(output.pbData, output.cbData); LocalFree(output.pbData);
  if (status != napi_ok) { napi_throw_error(env, nullptr, "Unable to return protected credentials"); return nullptr; }
  return result;
}
napi_value protect(napi_env env, napi_callback_info info) { return transform(env, info, true); }
napi_value unprotect(napi_env env, napi_callback_info info) { return transform(env, info, false); }
napi_value initialize(napi_env env, napi_value exports) {
  napi_value method;
  if (napi_create_function(env, "protect", NAPI_AUTO_LENGTH, protect, nullptr, &method) != napi_ok ||
      napi_set_named_property(env, exports, "protect", method) != napi_ok ||
      napi_create_function(env, "unprotect", NAPI_AUTO_LENGTH, unprotect, nullptr, &method) != napi_ok ||
      napi_set_named_property(env, exports, "unprotect", method) != napi_ok) return nullptr;
  return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
