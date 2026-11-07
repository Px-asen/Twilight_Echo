#include "twilight_audio_engine.h"

#include <node_api.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstring>
#include <functional>
#include <limits>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

TAE_EngineHandle g_engine = nullptr;
TAE_BridgeReceiverHandle g_bridgeReceiver = nullptr;
std::mutex g_eventMutex;
std::string g_lastError;

std::string unescapeJsonString(const std::string& value) {
  std::string out;
  out.reserve(value.size());
  bool escaped = false;
  for (char ch : value) {
    if (escaped) {
      switch (ch) {
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        default:
          out += ch;
          break;
      }
      escaped = false;
    } else if (ch == '\\') {
      escaped = true;
    } else {
      out += ch;
    }
  }
  return out;
}

std::string errorMessageFromPayload(const char* payload) {
  if (!payload) return {};
  const std::string json(payload);
  const std::string key = "\"message\":\"";
  const size_t start = json.find(key);
  if (start == std::string::npos) return json;
  const size_t valueStart = start + key.size();
  size_t end = valueStart;
  bool escaped = false;
  for (; end < json.size(); ++end) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (json[end] == '\\') {
      escaped = true;
      continue;
    }
    if (json[end] == '"') break;
  }
  return unescapeJsonString(json.substr(valueStart, end - valueStart));
}

void eventCallback(const char* eventType, const char* payloadJson, void*) {
  if (!eventType || std::string(eventType) != "error") return;
  std::lock_guard lock(g_eventMutex);
  g_lastError = errorMessageFromPayload(payloadJson);
}

void clearLastError() {
  std::lock_guard lock(g_eventMutex);
  g_lastError.clear();
}

std::string consumeLastError() {
  std::lock_guard lock(g_eventMutex);
  std::string out = g_lastError;
  g_lastError.clear();
  return out;
}

#ifdef _WIN32
constexpr DWORD kVst3ScannerTimeoutMs = 8000;
constexpr size_t kVst3ScannerOutputLimit = 512 * 1024;

struct Vst3ScannerResult {
  bool timedOut = false;
  bool outputTruncated = false;
  DWORD exitCode = static_cast<DWORD>(-1);
  std::string standardOutput;
  std::string standardError;
  std::string launchError;
};

std::string wideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string output(static_cast<size_t>(size), '\0');
  WideCharToMultiByte(
      CP_UTF8, 0, value.data(), static_cast<int>(value.size()), output.data(), size, nullptr, nullptr);
  return output;
}

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) return {};
  std::wstring output(static_cast<size_t>(size), L'\0');
  MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), output.data(), size);
  return output;
}

std::string windowsErrorMessage(DWORD error) {
  LPWSTR buffer = nullptr;
  const DWORD size = FormatMessageW(
      FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
      nullptr,
      error,
      0,
      reinterpret_cast<LPWSTR>(&buffer),
      0,
      nullptr);
  if (size == 0 || !buffer) return "Windows error " + std::to_string(error);
  std::wstring message(buffer, size);
  LocalFree(buffer);
  return wideToUtf8(message);
}

std::string trimText(std::string value) {
  const auto first = std::find_if_not(value.begin(), value.end(), [](unsigned char character) {
    return std::isspace(character) != 0;
  });
  const auto last = std::find_if_not(value.rbegin(), value.rend(), [](unsigned char character) {
    return std::isspace(character) != 0;
  }).base();
  return first < last ? std::string(first, last) : std::string();
}

std::wstring quoteWindowsArgument(const std::wstring& value) {
  std::wstring quoted;
  quoted.reserve(value.size() + 2);
  quoted.push_back(L'"');
  size_t backslashes = 0;
  for (const wchar_t character : value) {
    if (character == L'\\') {
      ++backslashes;
      continue;
    }
    if (character == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(character);
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, L'\\');
    backslashes = 0;
    quoted.push_back(character);
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

std::wstring scannerHelperPath(std::string& error) {
  HMODULE addon = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(scannerHelperPath),
          &addon)) {
    error = "Unable to resolve the native audio addon path: " + windowsErrorMessage(GetLastError());
    return {};
  }
  std::vector<wchar_t> path(32768, L'\0');
  const DWORD length = GetModuleFileNameW(addon, path.data(), static_cast<DWORD>(path.size()));
  if (length == 0 || length >= path.size() - 1) {
    error = "Unable to resolve the native audio addon filename: " + windowsErrorMessage(GetLastError());
    return {};
  }
  std::wstring addonPath(path.data(), length);
  const size_t separator = addonPath.find_last_of(L"\\/");
  if (separator == std::wstring::npos) {
    error = "Unable to resolve the isolated VST3 scanner directory";
    return {};
  }
  return addonPath.substr(0, separator + 1) + L"twilight-vst3-scanner.exe";
}

void drainPipe(HANDLE handle, std::string& output, bool& truncated) {
  std::array<char, 4096> buffer{};
  DWORD read = 0;
  while (ReadFile(handle, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr) && read > 0) {
    const size_t remaining = output.size() < kVst3ScannerOutputLimit
        ? kVst3ScannerOutputLimit - output.size()
        : 0;
    const size_t accepted = std::min(remaining, static_cast<size_t>(read));
    output.append(buffer.data(), accepted);
    if (accepted < read) truncated = true;
  }
  CloseHandle(handle);
}

Vst3ScannerResult runVst3Scanner(const std::string& modulePath) {
  Vst3ScannerResult result;
  const std::wstring modulePathWide = utf8ToWide(modulePath);
  if (modulePathWide.empty()) {
    result.launchError = "The VST3 module path is not valid UTF-8";
    return result;
  }

  std::string helperError;
  const std::wstring scannerPath = scannerHelperPath(helperError);
  if (scannerPath.empty()) {
    result.launchError = helperError;
    return result;
  }
  if (GetFileAttributesW(scannerPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
    result.launchError = "The isolated VST3 scanner helper is missing beside twilight_audio_node.node";
    return result;
  }

  SECURITY_ATTRIBUTES security{};
  security.nLength = sizeof(security);
  security.bInheritHandle = TRUE;
  HANDLE outputRead = nullptr;
  HANDLE outputWrite = nullptr;
  HANDLE errorRead = nullptr;
  HANDLE errorWrite = nullptr;
  HANDLE nullInput = INVALID_HANDLE_VALUE;
  if (!CreatePipe(&outputRead, &outputWrite, &security, 0) ||
      !SetHandleInformation(outputRead, HANDLE_FLAG_INHERIT, 0) ||
      !CreatePipe(&errorRead, &errorWrite, &security, 0) ||
      !SetHandleInformation(errorRead, HANDLE_FLAG_INHERIT, 0)) {
    result.launchError = "Unable to create VST3 scanner pipes: " + windowsErrorMessage(GetLastError());
    if (outputRead) CloseHandle(outputRead);
    if (outputWrite) CloseHandle(outputWrite);
    if (errorRead) CloseHandle(errorRead);
    if (errorWrite) CloseHandle(errorWrite);
    return result;
  }
  nullInput = CreateFileW(
      L"NUL",
      GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE,
      &security,
      OPEN_EXISTING,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  if (nullInput == INVALID_HANDLE_VALUE) {
    result.launchError = "Unable to prepare VST3 scanner input: " + windowsErrorMessage(GetLastError());
    CloseHandle(outputRead);
    CloseHandle(outputWrite);
    CloseHandle(errorRead);
    CloseHandle(errorWrite);
    return result;
  }

  const std::wstring command =
      quoteWindowsArgument(scannerPath) + L" --module " + quoteWindowsArgument(modulePathWide);
  std::vector<wchar_t> mutableCommand(command.begin(), command.end());
  mutableCommand.push_back(L'\0');
  const size_t separator = scannerPath.find_last_of(L"\\/");
  const std::wstring scannerDirectory = scannerPath.substr(0, separator);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW | STARTF_USESTDHANDLES;
  startup.wShowWindow = SW_HIDE;
  startup.hStdInput = nullInput;
  startup.hStdOutput = outputWrite;
  startup.hStdError = errorWrite;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
          scannerPath.c_str(),
          mutableCommand.data(),
          nullptr,
          nullptr,
          TRUE,
          CREATE_NO_WINDOW,
          nullptr,
          scannerDirectory.c_str(),
          &startup,
          &process)) {
    result.launchError = "Unable to launch the isolated VST3 scanner: " + windowsErrorMessage(GetLastError());
    CloseHandle(nullInput);
    CloseHandle(outputRead);
    CloseHandle(outputWrite);
    CloseHandle(errorRead);
    CloseHandle(errorWrite);
    return result;
  }
  CloseHandle(nullInput);
  CloseHandle(outputWrite);
  CloseHandle(errorWrite);

  std::thread outputReader(drainPipe, outputRead, std::ref(result.standardOutput), std::ref(result.outputTruncated));
  std::thread errorReader(drainPipe, errorRead, std::ref(result.standardError), std::ref(result.outputTruncated));
  const DWORD waitResult = WaitForSingleObject(process.hProcess, kVst3ScannerTimeoutMs);
  if (waitResult == WAIT_TIMEOUT) {
    result.timedOut = true;
    TerminateProcess(process.hProcess, 0xC000013A);
    WaitForSingleObject(process.hProcess, 1000);
  } else if (waitResult != WAIT_OBJECT_0) {
    result.launchError = "Unable to wait for the isolated VST3 scanner: " + windowsErrorMessage(GetLastError());
  }
  GetExitCodeProcess(process.hProcess, &result.exitCode);
  CloseHandle(process.hThread);
  CloseHandle(process.hProcess);
  outputReader.join();
  errorReader.join();
  return result;
}
#endif

napi_value makeUndefined(napi_env env) {
  napi_value value;
  napi_get_undefined(env, &value);
  return value;
}

std::string getStringArg(napi_env env, napi_value value) {
  size_t length = 0;
  napi_get_value_string_utf8(env, value, nullptr, 0, &length);
  std::vector<char> buffer(length + 1, '\0');
  napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
  return std::string(buffer.data(), length);
}

double getNumberArg(napi_env env, napi_value value, double fallback) {
  double out = fallback;
  napi_get_value_double(env, value, &out);
  return out;
}

bool getBoolArg(napi_env env, napi_value value, bool fallback) {
  bool out = fallback;
  napi_get_value_bool(env, value, &out);
  return out;
}

void ensureEngine() {
  if (!g_engine) {
    if (TAE_CreateEngine(&g_engine) == TAE_RESULT_OK && g_engine) {
      TAE_SetEventCallback(g_engine, eventCallback, nullptr);
      // eventCallback only keeps "error"; playback state is polled through
      // GetPlaybackInfo, so the engine need not serialize snapshot events.
      TAE_SetStateEventsEnabled(g_engine, 0);
    }
  }
}

napi_value throwOnError(napi_env env, TAE_Result result) {
  if (result != TAE_RESULT_OK) {
    std::string message = consumeLastError();
    if (message.empty()) {
      message = "原生音频引擎命令失败，结果码：" + std::to_string(static_cast<int>(result));
    }
    napi_throw_error(env, nullptr, message.c_str());
  }
  return makeUndefined(env);
}

napi_value readJson(napi_env env, TAE_Result (*fn)(TAE_EngineHandle, char*, size_t, size_t*)) {
  ensureEngine();
  size_t required = 0;
  fn(g_engine, nullptr, 0, &required);
  std::vector<char> buffer(required == 0 ? 1 : required);
  TAE_Result result = TAE_RESULT_OK;
  // The fill normally copies the snapshot the size probe kept for this thread.
  // Should it ever report INVALID_ARGUMENT with a larger required size, grow
  // and retry — the same pattern GetVisualizationData already uses.
  for (int attempt = 0; attempt < 3; ++attempt) {
    result = fn(g_engine, buffer.data(), buffer.size(), &required);
    if (result == TAE_RESULT_OK) break;
    if (result != TAE_RESULT_INVALID_ARGUMENT || required <= buffer.size()) break;
    buffer.assign(required, '\0');
  }
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value Play(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "播放需要音频地址");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  const double start = argc > 1 ? getNumberArg(env, argv[1], 0.0) : 0.0;
  return throwOnError(env, TAE_Play(g_engine, source.c_str(), start));
}

napi_value Pause(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_Pause(g_engine));
}

napi_value Stop(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_Stop(g_engine));
}

napi_value Seek(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  return throwOnError(env, TAE_Seek(g_engine, argc > 0 ? getNumberArg(env, argv[0], 0.0) : 0.0));
}

napi_value SetVolume(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  return throwOnError(env, TAE_SetVolume(g_engine, argc > 0 ? getNumberArg(env, argv[0], 1.0) : 1.0));
}

napi_value SetPlaybackRate(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  return throwOnError(env, TAE_SetPlaybackRate(g_engine, argc > 0 ? getNumberArg(env, argv[0], 1.0) : 1.0));
}

napi_value SetLoopRange(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double start = argc > 0 ? getNumberArg(env, argv[0], -1.0) : -1.0;
  const double end = argc > 1 ? getNumberArg(env, argv[1], -1.0) : -1.0;
  return throwOnError(env, TAE_SetLoopRange(g_engine, start, end));
}
napi_value SetAutoMixMode(napi_env env, napi_callback_info info) {
  ensureEngine(); clearLastError();
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const auto mode = argc ? getStringArg(env, argv[0]) : "off";
  return throwOnError(env, TAE_SetAutoMixMode(g_engine, mode.c_str()));
}
napi_value SelectAutoMix(napi_env env, napi_callback_info info) {
  ensureEngine(); clearLastError();
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const auto request = argc ? getStringArg(env, argv[0]) : "{}";
  size_t required = 0;
  auto result = TAE_SelectAutoMix(g_engine, request.c_str(), nullptr, 0, &required);
  if (required > 256 * 1024 || !required) return throwOnError(env, TAE_RESULT_INVALID_ARGUMENT);
  std::vector<char> buffer(required);
  result = TAE_SelectAutoMix(g_engine, request.c_str(), buffer.data(), buffer.size(), &required);
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value value; napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &value); return value;
}
napi_value PrepareAutoMix(napi_env env, napi_callback_info info) {
  ensureEngine(); clearLastError();
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const auto request = argc ? getStringArg(env, argv[0]) : "{}";
  return throwOnError(env, TAE_PrepareAutoMix(g_engine, request.c_str()));
}
napi_value BindBridgeAutoMixSelection(napi_env env, napi_callback_info info) {
  ensureEngine(); clearLastError();
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const auto request = argc ? getStringArg(env, argv[0]) : "{}";
  size_t required = 0;
  auto result = TAE_BindBridgeAutoMixSelection(g_engine, request.c_str(), nullptr, 0, &required);
  if (required > 256 * 1024 || !required) return throwOnError(env, TAE_RESULT_INVALID_ARGUMENT);
  std::vector<char> buffer(required);
  result = TAE_BindBridgeAutoMixSelection(g_engine, request.c_str(), buffer.data(), buffer.size(), &required);
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value value; napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &value); return value;
}
napi_value SubmitAutoMix(napi_env env, napi_callback_info info) {
  ensureEngine(); clearLastError();
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const auto id = argc ? getNumberArg(env, argv[0], 0) : 0;
  if (!std::isfinite(id) || id < 1 || id > 9007199254740991.0 || std::floor(id) != id)
    return throwOnError(env, TAE_RESULT_INVALID_ARGUMENT);
  return throwOnError(env, TAE_SubmitAutoMix(g_engine, static_cast<uint64_t>(id)));
}
napi_value CancelAutoMix(napi_env env, napi_callback_info) {
  ensureEngine(); clearLastError();
  return throwOnError(env, TAE_CancelAutoMix(g_engine));
}

napi_value SetOutputDevice(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string device = argc > 0 ? getStringArg(env, argv[0]) : "auto";
  return throwOnError(env, TAE_SetOutputDevice(g_engine, device.c_str()));
}

napi_value SetOutputBackend(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string backend = argc > 0 ? getStringArg(env, argv[0]) : "wasapi";
  return throwOnError(env, TAE_SetOutputBackend(g_engine, backend.c_str()));
}

napi_value LoadQueue(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string queue = argc > 0 ? getStringArg(env, argv[0]) : "[]";
  const int start = argc > 1 ? static_cast<int>(getNumberArg(env, argv[1], 0.0)) : 0;
  return throwOnError(env, TAE_LoadQueue(g_engine, queue.c_str(), start));
}

napi_value Next(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_Next(g_engine));
}

napi_value RebindQueue(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 5) return throwOnError(env, TAE_RESULT_INVALID_ARGUMENT);
  const double start = getNumberArg(env, argv[1], -1.0);
  const double expectedIndex = getNumberArg(env, argv[4], -1.0);
  for (const double index : {start, expectedIndex}) {
    if (!std::isfinite(index) || index < 0 || index > std::numeric_limits<int>::max() ||
        std::floor(index) != index) return throwOnError(env, TAE_RESULT_INVALID_ARGUMENT);
  }
  const auto queue = getStringArg(env, argv[0]);
  const auto mode = getStringArg(env, argv[2]);
  const auto expected = getStringArg(env, argv[3]);
  int applied = 0;
  const auto result = TAE_RebindQueue(g_engine, queue.c_str(), static_cast<int>(start),
      mode.c_str(), expected.c_str(), static_cast<int>(expectedIndex), &applied);
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value value;
  napi_get_boolean(env, applied != 0, &value);
  return value;
}

napi_value AppendQueueItems(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string items = argc > 0 ? getStringArg(env, argv[0]) : "[]";
  // The JS bridge returns void for the whole binding; hosts read the absolute
  // append position from GetQueueState().revision/size or their local mirror.
  return throwOnError(env, TAE_AppendQueueItems(g_engine, items.c_str(), nullptr));
}

napi_value UpdateQueueItemSource(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double rawIndex = argc > 0 ? getNumberArg(env, argv[0], -1.0) : -1.0;
  if (!std::isfinite(rawIndex) || rawIndex < 0 || rawIndex > std::numeric_limits<int>::max() ||
      std::floor(rawIndex) != rawIndex)
    return throwOnError(env, TAE_RESULT_INVALID_ARGUMENT);
  const std::string source = argc > 1 ? getStringArg(env, argv[1]) : "";
  return throwOnError(
      env,
      TAE_UpdateQueueItemSource(g_engine, static_cast<int>(rawIndex), source.c_str()));
}

napi_value GetQueueState(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetQueueState);
}

napi_value Previous(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_Previous(g_engine));
}

napi_value SelectQueueIndex(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double index = argc > 0 ? getNumberArg(env, argv[0], -1.0) : -1.0;
  if (!std::isfinite(index) || index < 0 || index > std::numeric_limits<int>::max() || std::floor(index) != index)
    return throwOnError(env, TAE_RESULT_INVALID_ARGUMENT);
  return throwOnError(env, TAE_SelectQueueIndex(g_engine, static_cast<int>(index)));
}

napi_value SetPlayMode(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string mode = argc > 0 ? getStringArg(env, argv[0]) : "sequential";
  return throwOnError(env, TAE_SetPlayMode(g_engine, mode.c_str()));
}

napi_value SetDspConfig(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  return throwOnError(env, TAE_SetDspConfig(g_engine, json.c_str()));
}

napi_value SetDspGraph(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{\"graph\":{\"nodes\":[]}}";
  return throwOnError(env, TAE_SetDspGraph(g_engine, json.c_str()));
}

napi_value ApplyDspState(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double revisionValue = argc > 0 ? getNumberArg(env, argv[0], 0.0) : 0.0;
  if (!std::isfinite(revisionValue) || revisionValue <= 0.0 ||
      std::floor(revisionValue) != revisionValue) {
    napi_throw_type_error(env, "TAE_DSP_REVISION_REQUIRED", "ApplyDspState requires a positive integer revision");
    return makeUndefined(env);
  }
  const std::string json = argc > 1 ? getStringArg(env, argv[1]) : "{}";
  return throwOnError(
      env,
      TAE_ApplyDspState(g_engine, static_cast<uint64_t>(revisionValue), json.c_str()));
}

napi_value GetDspGraphStatus(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetDspGraphStatus);
}

napi_value ScanVst3Module(napi_env env, napi_callback_info info) {
#ifdef _WIN32
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, "TAE_VST3_MODULE_REQUIRED", "VST3 scanning requires a module path");
    return makeUndefined(env);
  }
  const std::string modulePath = getStringArg(env, argv[0]);
  if (modulePath.empty()) {
    napi_throw_type_error(env, "TAE_VST3_MODULE_REQUIRED", "VST3 module path must not be empty");
    return makeUndefined(env);
  }

  const Vst3ScannerResult result = runVst3Scanner(modulePath);
  if (!result.launchError.empty()) {
    napi_throw_error(env, "TAE_VST3_SCANNER_UNAVAILABLE", result.launchError.c_str());
    return makeUndefined(env);
  }
  if (result.timedOut) {
    napi_throw_error(env, "TAE_VST3_SCAN_TIMEOUT", "The isolated VST3 scanner exceeded its 8 second limit");
    return makeUndefined(env);
  }
  if (result.outputTruncated) {
    napi_throw_error(env, "TAE_VST3_SCAN_OUTPUT_LIMIT", "The isolated VST3 scanner exceeded its output limit");
    return makeUndefined(env);
  }
  if (result.exitCode != 0) {
    const std::string detail = trimText(
        result.standardError.empty() ? result.standardOutput : result.standardError);
    const std::string message = "The isolated VST3 scanner exited with code " +
        std::to_string(result.exitCode) + (detail.empty() ? std::string() : ": " + detail);
    napi_throw_error(env, "TAE_VST3_SCAN_FAILED", message.c_str());
    return makeUndefined(env);
  }
  const std::string output = trimText(result.standardOutput);
  if (output.empty()) {
    napi_throw_error(env, "TAE_VST3_SCAN_EMPTY", "The isolated VST3 scanner returned no descriptor");
    return makeUndefined(env);
  }
  napi_value descriptor;
  napi_create_string_utf8(env, output.c_str(), output.size(), &descriptor);
  return descriptor;
#else
  napi_throw_error(
      env,
      "TAE_VST3_UNSUPPORTED",
      "VST3 scanning is unavailable: this audio-engine build does not include the isolated VST3 scanner helper");
  return makeUndefined(env);
#endif
}

napi_value SetOutputConfig(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  return throwOnError(env, TAE_SetOutputConfig(g_engine, json.c_str()));
}

napi_value LoadImpulseResponse(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "加载脉冲响应需要文件路径");
    return makeUndefined(env);
  }
  const std::string path = getStringArg(env, argv[0]);
  return throwOnError(env, TAE_LoadImpulseResponse(g_engine, path.c_str()));
}

napi_value UnloadImpulseResponse(napi_env env, napi_callback_info) {
  ensureEngine();
  clearLastError();
  return throwOnError(env, TAE_UnloadImpulseResponse(g_engine));
}

napi_value GetConvolverInfo(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetConvolverInfo);
}

napi_value SetEqBands(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  return throwOnError(env, TAE_SetEqBands(g_engine, json.c_str()));
}

napi_value SetEqPreset(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  return throwOnError(env, TAE_SetEqPreset(g_engine, json.c_str()));
}

napi_value SetCrossfeedStrength(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double strength = argc > 0 ? getNumberArg(env, argv[0], 0.0) : 0.0;
  return throwOnError(env, TAE_SetCrossfeedStrength(g_engine, strength));
}

napi_value SetReplayGainMode(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 4;
  napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string mode = argc > 0 ? getStringArg(env, argv[0]) : "off";
  const double preamp = argc > 1 ? getNumberArg(env, argv[1], 0.0) : 0.0;
  const double fallback = argc > 2 ? getNumberArg(env, argv[2], 0.0) : 0.0;
  const bool clip = argc > 3 ? getBoolArg(env, argv[3], true) : true;
  return throwOnError(env, TAE_SetReplayGainMode(g_engine, mode.c_str(), preamp, fallback, clip ? 1 : 0));
}

napi_value SetDspPluginChain(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string json = argc > 0 ? getStringArg(env, argv[0]) : "{\"plugins\":[]}";
  return throwOnError(env, TAE_SetDspPluginChain(g_engine, json.c_str()));
}

napi_value GetDspPluginStatus(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetDspPluginStatus);
}

napi_value GetMetadata(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "读取元数据需要音频地址");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  size_t required = 0;
  TAE_GetMetadata(g_engine, source.c_str(), nullptr, 0, &required);
  std::vector<char> buffer(required == 0 ? 1 : required);
  TAE_Result result = TAE_RESULT_OK;
  // Same probe/fill growth race as readJson: retry while the snapshot grew.
  for (int attempt = 0; attempt < 3; ++attempt) {
    result = TAE_GetMetadata(g_engine, source.c_str(), buffer.data(), buffer.size(), &required);
    if (result == TAE_RESULT_OK) break;
    if (result != TAE_RESULT_INVALID_ARGUMENT || required <= buffer.size()) break;
    buffer.assign(required, '\0');
  }
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value GetPlaybackInfo(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetPlaybackInfo);
}

napi_value SetDiagnosticContext(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string context = argc ? getStringArg(env, argv[0]) : "{}";
  TAE_SetDiagnosticContext(context.c_str());
  napi_value result; napi_get_undefined(env, &result); return result;
}

napi_value GetDiagnosticLog(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double sinceRaw = argc > 0 ? getNumberArg(env, argv[0], 0.0) : 0.0;
  const double maxRaw = argc > 1 ? getNumberArg(env, argv[1], 0.0) : 0.0;
  const auto sinceSequence = static_cast<uint64_t>(sinceRaw > 0 ? sinceRaw : 0);
  const auto maxEntries = static_cast<size_t>(maxRaw > 0 ? maxRaw : 0);
  size_t required = 0;
  uint64_t nextSequence = 0;
  TAE_GetDiagnosticLog(g_engine, sinceSequence, maxEntries, nullptr, 0, &required, &nextSequence);
  std::vector<char> buffer(required == 0 ? 1 : required);
  TAE_Result result = TAE_RESULT_OK;
  // New entries can land between the size probe and the fill; re-probe until a
  // snapshot fits, mirroring readJson.
  for (int attempt = 0; attempt < 3; ++attempt) {
    result = TAE_GetDiagnosticLog(
        g_engine, sinceSequence, maxEntries, buffer.data(), buffer.size(), &required, &nextSequence);
    if (result == TAE_RESULT_OK) break;
    if (result != TAE_RESULT_INVALID_ARGUMENT || required <= buffer.size()) break;
    buffer.assign(required, '\0');
  }
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value GetQueue(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetQueue);
}

napi_value GetUpcomingTrack(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetUpcomingTrack);
}

napi_value GetDspConfig(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetDspConfig);
}

napi_value EnumerateDevices(napi_env env, napi_callback_info) {
  return readJson(env, TAE_EnumerateDevices);
}

napi_value EnumerateBackends(napi_env env, napi_callback_info) {
  return readJson(env, TAE_EnumerateBackends);
}

napi_value GetEngineCapabilities(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetEngineCapabilities);
}

napi_value GetLastError(napi_env env, napi_callback_info) {
  return readJson(env, TAE_GetLastError);
}

napi_value GetSpectrumData(napi_env env, napi_callback_info info) {
  ensureEngine();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const size_t points = argc > 0 ? static_cast<size_t>(getNumberArg(env, argv[0], 64.0)) : 64;
  std::vector<float> spectrum(points);
  size_t written = 0;
  TAE_GetSpectrumData(g_engine, spectrum.data(), spectrum.size(), &written);
  napi_value array;
  napi_create_array_with_length(env, written, &array);
  for (size_t i = 0; i < written; ++i) {
    napi_value value;
    napi_create_double(env, spectrum[i], &value);
    napi_set_element(env, array, static_cast<uint32_t>(i), value);
  }
  return array;
}

napi_value SetVisualizationDemand(napi_env env, napi_callback_info info) {
  ensureEngine();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool enabled = false;
  if (argc < 1 || napi_get_value_bool(env, argv[0], &enabled) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Visualization demand must be a boolean");
    return nullptr;
  }
  return throwOnError(env, TAE_SetVisualizationDemand(g_engine, enabled ? 1 : 0));
}

napi_value GetVisualizationData(napi_env env, napi_callback_info info) {
  ensureEngine();
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const std::string options = argc > 0 ? getStringArg(env, argv[0]) : "{}";
  size_t required = 0;
  std::vector<char> buffer(65536);
  TAE_Result result = TAE_GetVisualizationData(g_engine, options.c_str(), buffer.data(), buffer.size(), &required);
  if (result == TAE_RESULT_INVALID_ARGUMENT && required > buffer.size()) {
    buffer.assign(required, '\0');
    result = TAE_GetVisualizationData(g_engine, options.c_str(), buffer.data(), buffer.size(), &required);
  }
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value RenderPcmSegment(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 5) {
    napi_throw_type_error(env, nullptr, "PCM segment requires source, output and source bounds");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  const std::string output = getStringArg(env, argv[1]);
  std::array<char, 2048> error{};
  const auto result = TAE_RenderPcmSegment(source.c_str(), output.c_str(),
      getNumberArg(env, argv[2], -1), getNumberArg(env, argv[3], -1),
      getNumberArg(env, argv[4], -1), error.data(), error.size());
  if (result != TAE_RESULT_OK) napi_throw_error(env, nullptr, error.data());
  return makeUndefined(env);
}

napi_value AnalyzeBpm(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "BPM 分析需要音频文件路径");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  const std::string options = argc > 1 ? getStringArg(env, argv[1]) : "{}";
  size_t required = 0;
  TAE_AnalyzeBpm(g_engine, source.c_str(), options.c_str(), nullptr, 0, &required);
  std::vector<char> buffer(required == 0 ? 1 : required);
  const TAE_Result result = TAE_AnalyzeBpm(g_engine, source.c_str(), options.c_str(), buffer.data(), buffer.size(), &required);
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value AnalyzeAutoMix(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "Twilight AutoMix analysis requires an audio source");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  const std::string options = argc > 1 ? getStringArg(env, argv[1]) : "{}";
  size_t required = 0;
  TAE_Result result = TAE_AnalyzeAutoMix(g_engine, source.c_str(), options.c_str(), nullptr, 0, &required);
  if (required > 512 * 1024) {
    napi_throw_error(env, nullptr, "Twilight AutoMix analysis exceeded its response budget");
    return makeUndefined(env);
  }
  std::vector<char> buffer(required == 0 ? 1 : required);
  result = TAE_AnalyzeAutoMix(g_engine, source.c_str(), options.c_str(), buffer.data(), buffer.size(), &required);
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value AnalyzeLoudness(napi_env env, napi_callback_info info) {
  ensureEngine();
  clearLastError();
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "响度分析需要音频文件路径");
    return makeUndefined(env);
  }
  const std::string source = getStringArg(env, argv[0]);
  const std::string options = argc > 1 ? getStringArg(env, argv[1]) : "{}";
  size_t required = 0;
  TAE_AnalyzeLoudness(g_engine, source.c_str(), options.c_str(), nullptr, 0, &required);
  std::vector<char> buffer(required == 0 ? 1 : required);
  const TAE_Result result =
      TAE_AnalyzeLoudness(g_engine, source.c_str(), options.c_str(), buffer.data(), buffer.size(), &required);
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value json;
  napi_create_string_utf8(env, buffer.data(), NAPI_AUTO_LENGTH, &json);
  return json;
}

napi_value SetBridgeQueueControl(napi_env env, napi_callback_info info) {
  ensureEngine();
  size_t argc = 3; napi_value argv[3]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (!argc) { napi_throw_type_error(env, nullptr, "Bridge queue control requires ownership"); return makeUndefined(env); }
  return throwOnError(env, TAE_SetBridgeQueueControl(g_engine, getBoolArg(env, argv[0], false),
      argc > 1 ? getStringArg(env, argv[1]).c_str() : "", argc > 2 ? getStringArg(env, argv[2]).c_str() : ""));
}
napi_value SetBridgeAutoMixMode(napi_env env, napi_callback_info info) {
  ensureEngine(); size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const auto mode = argc ? getStringArg(env, argv[0]) : "off";
  return throwOnError(env, TAE_SetBridgeAutoMixMode(g_engine, mode.c_str()));
}
napi_value CommitBridgeSourceControls(napi_env env, napi_callback_info) {
  ensureEngine(); return throwOnError(env, TAE_CommitBridgeSourceControls(g_engine));
}
napi_value PullBridgePcm(napi_env env, napi_callback_info info) {
  ensureEngine();
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double requested = argc ? getNumberArg(env, argv[0], 0) : 0;
  if (requested < 1 || requested > 2048 || std::floor(requested) != requested) {
    napi_throw_range_error(env, nullptr, "Bridge pull requires 1–2048 frames"); return makeUndefined(env);
  }
  std::array<float, 4096> pcm{};
  std::array<char, 64 * 1024> timeline{};
  TAE_BridgePcmInfo facts{};
  const auto result = TAE_PullBridgePcmTimeline(g_engine, pcm.data(), static_cast<size_t>(requested), &facts, timeline.data(), timeline.size());
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value object, value;
  napi_create_object(env, &object);
  const auto number = [&](const char* key, double v) {
    napi_create_double(env, v, &value); napi_set_named_property(env, object, key, value);
  };
  number("generation", static_cast<double>(facts.generation));
  number("sampleRate", facts.sample_rate); number("channels", facts.channels); number("frames", facts.frames);
  napi_get_boolean(env, facts.playing != 0, &value); napi_set_named_property(env, object, "playing", value);
  napi_create_buffer_copy(env, facts.frames * facts.channels * sizeof(float), pcm.data(), nullptr, &value);
  napi_set_named_property(env, object, "pcm", value);
  napi_create_string_utf8(env, timeline.data(), NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, object, "sourceTimeline", value);
  return object;
}
napi_value CloseBridgeReceiver(napi_env env, napi_callback_info) {
  TAE_CloseBridgeReceiver(g_bridgeReceiver); g_bridgeReceiver = nullptr;
  return makeUndefined(env);
}
napi_value PullBridgeAudio(napi_env env, napi_callback_info info) {
  ensureEngine();
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double frames = argc ? getNumberArg(env, argv[0], 0) : 0;
  if (frames < 1 || frames > 2048 || std::floor(frames) != frames) {
    napi_throw_range_error(env, nullptr, "Bridge pull requires 1-2048 frames"); return makeUndefined(env);
  }
  std::array<float, 2048*8> data{};
  TAE_BridgeAudioInfo facts{};
  const auto result = TAE_PullBridgeAudio(g_engine, data.data(), sizeof(data), static_cast<size_t>(frames), &facts);
  if (result != TAE_RESULT_OK) return throwOnError(env, result);
  napi_value object, value; napi_create_object(env, &object);
  const auto number = [&](const char* name, double n) { napi_create_double(env, n, &value); napi_set_named_property(env, object, name, value); };
  number("generation", static_cast<double>(facts.pcm.generation)); number("sampleRate", facts.pcm.sample_rate);
  number("channels", facts.pcm.channels); number("frames", facts.pcm.frames); number("channelMask", static_cast<double>(facts.channel_mask));
  number("wireCode", facts.wire_format);
  napi_get_boolean(env, facts.pcm.playing != 0, &value); napi_set_named_property(env, object, "playing", value);
  napi_create_buffer_copy(env, facts.bytes, data.data(), nullptr, &value); napi_set_named_property(env, object, "audio", value);
  return object;
}
napi_value OpenBridgeStreamReceiver(napi_env env, napi_callback_info info) {
  size_t argc = 6; napi_value argv[6]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 6) { napi_throw_type_error(env, nullptr, "Bridge stream requires backend, DAC, rate, channels, wire code and channel mask"); return makeUndefined(env); }
  const double rate = getNumberArg(env, argv[2], 0), channels = getNumberArg(env, argv[3], 0), code = getNumberArg(env, argv[4], 0), mask = getNumberArg(env, argv[5], -1);
  if (!std::isfinite(rate) || std::floor(rate) != rate || rate < 44100 || rate > 24576000 ||
      channels < 1 || channels > 8 || std::floor(channels) != channels ||
      code < 1 || code > 5 || std::floor(code) != code || mask < 0 || mask > 0x3ffff || std::floor(mask) != mask) {
    napi_throw_range_error(env, nullptr, "Invalid Bridge stream format"); return makeUndefined(env);
  }
  TAE_CloseBridgeReceiver(g_bridgeReceiver); g_bridgeReceiver = nullptr;
  const auto backend = getStringArg(env, argv[0]), device = getStringArg(env, argv[1]);
  std::array<char, 2048> error{};
  const auto result = TAE_OpenBridgeStreamReceiver(backend.c_str(), device.c_str(), static_cast<int>(rate), static_cast<int>(channels),
      static_cast<int>(code), static_cast<uint64_t>(mask), &g_bridgeReceiver, error.data(), error.size());
  if (result != TAE_RESULT_OK) napi_throw_error(env, nullptr, error.data());
  return makeUndefined(env);
}
napi_value WriteBridgeAudio(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1]; napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool buffer = false; if (argc) napi_is_buffer(env, argv[0], &buffer);
  void* data = nullptr; size_t bytes = 0;
  if (buffer) napi_get_buffer_info(env, argv[0], &data, &bytes);
  if (!data || !bytes || bytes > 2048*8*4) { napi_throw_range_error(env, nullptr, "Invalid Bridge audio block"); return makeUndefined(env); }
  return throwOnError(env, TAE_WriteBridgeAudio(g_bridgeReceiver, data, bytes));
}
napi_value OpenBridgeReceiver(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc != 4) { napi_throw_type_error(env, nullptr, "Bridge requires backend, DAC, rate and channels"); return makeUndefined(env); }
  TAE_CloseBridgeReceiver(g_bridgeReceiver); g_bridgeReceiver = nullptr;
  const auto backend = getStringArg(env, argv[0]), device = getStringArg(env, argv[1]);
  std::array<char, 2048> error{};
  const auto result = TAE_OpenBridgeReceiver(backend.c_str(), device.c_str(),
      static_cast<int>(getNumberArg(env, argv[2], 0)), static_cast<int>(getNumberArg(env, argv[3], 0)),
      &g_bridgeReceiver, error.data(), error.size());
  if (result != TAE_RESULT_OK) napi_throw_error(env, nullptr, error.data());
  return makeUndefined(env);
}
napi_value WriteBridgePcm(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool isBuffer = false;
  if (argc) napi_is_buffer(env, argv[0], &isBuffer);
  void* data = nullptr; size_t bytes = 0;
  if (isBuffer) napi_get_buffer_info(env, argv[0], &data, &bytes);
  if (!data || !bytes || bytes % 8 || bytes > 2048 * 8) {
    napi_throw_range_error(env, nullptr, "Invalid stereo Float32 PCM block"); return makeUndefined(env);
  }
  std::array<float, 4096> aligned{};
  std::memcpy(aligned.data(), data, bytes);
  return throwOnError(env, TAE_WriteBridgePcm(g_bridgeReceiver, aligned.data(), bytes / 8));
}
napi_value StartBridgeReceiver(napi_env env, napi_callback_info) {
  return throwOnError(env, TAE_StartBridgeReceiver(g_bridgeReceiver));
}
napi_value PrepareBridgeTimedReceiver(napi_env env, napi_callback_info) {
  return throwOnError(env, TAE_PrepareBridgeTimedReceiver(g_bridgeReceiver));
}
napi_value PrepareBridgeAdaptiveReceiver(napi_env env, napi_callback_info) {
  return throwOnError(env, TAE_PrepareBridgeAdaptiveReceiver(g_bridgeReceiver));
}
napi_value SetBridgeTimedCorrection(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double ppm = argc > 0 ? getNumberArg(env, argv[0], NAN) : NAN;
  const double generation = argc > 1 ? getNumberArg(env, argv[1], -1) : -1;
  if (argc != 2 || !std::isfinite(ppm) || std::abs(ppm) > 1000 || !std::isfinite(generation) ||
      generation < 1 || std::floor(generation) != generation || generation > 9007199254740991.0) {
    napi_throw_range_error(env, nullptr, "Clock correction requires +/-1000 ppm and the current stream generation");
    return makeUndefined(env);
  }
  return throwOnError(env, TAE_SetBridgeTimedCorrection(g_bridgeReceiver, ppm, static_cast<uint64_t>(generation)));
}
napi_value ArmBridgeTimedReceiver(napi_env env, napi_callback_info info) {
  size_t argc = 3; napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  const double time = argc > 0 ? getNumberArg(env, argv[0], -1) : -1;
  const double generation = argc > 1 ? getNumberArg(env, argv[1], -1) : -1;
  const double frame = argc > 2 ? getNumberArg(env, argv[2], -1) : -1;
  if (argc != 3 || !std::isfinite(time) || time <= 0 || !std::isfinite(generation) || generation < 1 ||
      std::floor(generation) != generation || generation > 9007199254740991.0 || !std::isfinite(frame) ||
      frame < 0 || std::floor(frame) != frame || frame > 9007199254740991.0) {
    napi_throw_range_error(env, nullptr, "Timed arm requires a timestamp, stream generation and media frame");
    return makeUndefined(env);
  }
  return throwOnError(env, TAE_ArmBridgeTimedReceiver(g_bridgeReceiver, time,
      static_cast<uint64_t>(generation), static_cast<uint64_t>(frame)));
}
napi_value EndBridgeTimedReceiver(napi_env env, napi_callback_info) {
  return throwOnError(env, TAE_EndBridgeTimedReceiver(g_bridgeReceiver));
}
napi_value GetBridgeReceiverInfo(napi_env env, napi_callback_info) {
  std::array<char, 16384> json{}; size_t required = 0;
  const auto result = TAE_GetBridgeReceiverInfo(g_bridgeReceiver, json.data(), json.size(), &required);
  if (result != TAE_RESULT_OK || required > json.size()) return throwOnError(env, TAE_RESULT_INTERNAL_ERROR);
  napi_value value; napi_create_string_utf8(env, json.data(), NAPI_AUTO_LENGTH, &value); return value;
}

void cleanup(void*) {
  TAE_CloseBridgeReceiver(g_bridgeReceiver); g_bridgeReceiver = nullptr;
  if (g_engine) {
    TAE_DestroyEngine(g_engine);
    g_engine = nullptr;
  }
}

void define(napi_env env, napi_value exports, const char* name, napi_callback callback) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, nullptr, &fn);
  napi_set_named_property(env, exports, name, fn);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_add_env_cleanup_hook(env, cleanup, nullptr);
  define(env, exports, "Play", Play);
  define(env, exports, "PullBridgePcm", PullBridgePcm);
  define(env, exports, "SetBridgeQueueControl", SetBridgeQueueControl);
  define(env, exports, "SetBridgeAutoMixMode", SetBridgeAutoMixMode);
  define(env, exports, "CommitBridgeSourceControls", CommitBridgeSourceControls);
  define(env, exports, "PullBridgeAudio", PullBridgeAudio);
  define(env, exports, "OpenBridgeStreamReceiver", OpenBridgeStreamReceiver);
  define(env, exports, "WriteBridgeAudio", WriteBridgeAudio);
  define(env, exports, "OpenBridgeReceiver", OpenBridgeReceiver);
  define(env, exports, "CloseBridgeReceiver", CloseBridgeReceiver);
  define(env, exports, "WriteBridgePcm", WriteBridgePcm);
  define(env, exports, "StartBridgeReceiver", StartBridgeReceiver);
  define(env, exports, "PrepareBridgeTimedReceiver", PrepareBridgeTimedReceiver);
  define(env, exports, "PrepareBridgeAdaptiveReceiver", PrepareBridgeAdaptiveReceiver);
  define(env, exports, "SetBridgeTimedCorrection", SetBridgeTimedCorrection);
  define(env, exports, "ArmBridgeTimedReceiver", ArmBridgeTimedReceiver);
  define(env, exports, "EndBridgeTimedReceiver", EndBridgeTimedReceiver);
  define(env, exports, "GetBridgeReceiverInfo", GetBridgeReceiverInfo);
  define(env, exports, "Pause", Pause);
  define(env, exports, "Stop", Stop);
  define(env, exports, "Seek", Seek);
  define(env, exports, "SetVolume", SetVolume);
  define(env, exports, "SetPlaybackRate", SetPlaybackRate);
  define(env, exports, "SetLoopRange", SetLoopRange);
  define(env, exports, "SetOutputDevice", SetOutputDevice);
  define(env, exports, "SetOutputBackend", SetOutputBackend);
  define(env, exports, "LoadQueue", LoadQueue);
  define(env, exports, "RebindQueue", RebindQueue);
  define(env, exports, "AppendQueueItems", AppendQueueItems);
  define(env, exports, "UpdateQueueItemSource", UpdateQueueItemSource);
  define(env, exports, "GetQueueState", GetQueueState);
  define(env, exports, "SelectQueueIndex", SelectQueueIndex);
  define(env, exports, "Next", Next);
  define(env, exports, "Previous", Previous);
  define(env, exports, "SetPlayMode", SetPlayMode);
  define(env, exports, "SetDspConfig", SetDspConfig);
  define(env, exports, "SetDspGraph", SetDspGraph);
  define(env, exports, "ApplyDspState", ApplyDspState);
  define(env, exports, "GetDspGraphStatus", GetDspGraphStatus);
  define(env, exports, "ScanVst3Module", ScanVst3Module);
  define(env, exports, "SetOutputConfig", SetOutputConfig);
  define(env, exports, "LoadImpulseResponse", LoadImpulseResponse);
  define(env, exports, "UnloadImpulseResponse", UnloadImpulseResponse);
  define(env, exports, "GetConvolverInfo", GetConvolverInfo);
  define(env, exports, "SetEqBands", SetEqBands);
  define(env, exports, "SetEqPreset", SetEqPreset);
  define(env, exports, "SetCrossfeedStrength", SetCrossfeedStrength);
  define(env, exports, "SetReplayGainMode", SetReplayGainMode);
  define(env, exports, "SetDspPluginChain", SetDspPluginChain);
  define(env, exports, "GetDspPluginStatus", GetDspPluginStatus);
  define(env, exports, "GetMetadata", GetMetadata);
  define(env, exports, "GetPlaybackInfo", GetPlaybackInfo);
  define(env, exports, "GetDiagnosticLog", GetDiagnosticLog);
  define(env, exports, "SetDiagnosticContext", SetDiagnosticContext);
  define(env, exports, "GetQueue", GetQueue);
  define(env, exports, "GetUpcomingTrack", GetUpcomingTrack);
  define(env, exports, "GetDspConfig", GetDspConfig);
  define(env, exports, "EnumerateDevices", EnumerateDevices);
  define(env, exports, "EnumerateBackends", EnumerateBackends);
  define(env, exports, "GetEngineCapabilities", GetEngineCapabilities);
  define(env, exports, "GetLastError", GetLastError);
  define(env, exports, "GetSpectrumData", GetSpectrumData);
  define(env, exports, "GetVisualizationData", GetVisualizationData);
  define(env, exports, "SetVisualizationDemand", SetVisualizationDemand);
  define(env, exports, "AnalyzeBpm", AnalyzeBpm);
  define(env, exports, "RenderPcmSegment", RenderPcmSegment);
  define(env, exports, "AnalyzeAutoMix", AnalyzeAutoMix);
  define(env, exports, "SetAutoMixMode", SetAutoMixMode);
  define(env, exports, "SelectAutoMix", SelectAutoMix);
  define(env, exports, "BindBridgeAutoMixSelection", BindBridgeAutoMixSelection);
  define(env, exports, "PrepareAutoMix", PrepareAutoMix);
  define(env, exports, "SubmitAutoMix", SubmitAutoMix);
  define(env, exports, "CancelAutoMix", CancelAutoMix);
  define(env, exports, "AnalyzeLoudness", AnalyzeLoudness);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
