#pragma once
#ifdef _WIN32
#include <windows.h>
#include <tlhelp32.h>
#include <string>
#include <vector>
#include <cstdio>

namespace twilight::diagnostics {
inline std::wstring environment(const wchar_t* name) {
  const DWORD count = GetEnvironmentVariableW(name, nullptr, 0);
  if (!count) return {};
  std::vector<wchar_t> value(count);
  GetEnvironmentVariableW(name, value.data(), count);
  return value.data();
}
inline DWORD parentProcessId(DWORD pid) {
  const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  DWORD parent = 0;
  if (Process32FirstW(snapshot, &entry)) do {
    if (entry.th32ProcessID == pid) { parent = entry.th32ParentProcessID; break; }
  } while (Process32NextW(snapshot, &entry));
  CloseHandle(snapshot);
  return parent;
}
// Called only on startup, before loading the driver/plugin. Never on an audio callback.
inline void registerCrashCapture() {
  if (environment(L"TWILIGHT_DEBUG_CRASHES") != L"1") return;
  auto helper = environment(L"TWILIGHT_DEBUG_CRASH_HELPER");
  const auto directory = environment(L"TWILIGHT_DEBUG_DIRECTORY") + L"\\crashes";
  const auto session = environment(L"TWILIGHT_DEBUG_SESSION_ID");
  if (helper.empty() || session.empty()) return;
#ifndef _WIN64
  const auto suffix = helper.rfind(L".exe");
  if (suffix != std::wstring::npos) helper.insert(suffix, L"-x86");
#endif
  if (!CreateDirectoryW(directory.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) {
    std::fprintf(stderr, "[TwilightDiagnostics] crash directory creation failed: %lu\n", GetLastError()); return;
  }
  const auto pid = GetCurrentProcessId();
  const auto ready = directory + L"\\attach-" + std::to_wstring(pid) + L".json";
  DeleteFileW(ready.c_str()); // A reused PID must not consume a previous process's receipt.
  const auto failure = [&](const char* stage, DWORD code) {
    std::fprintf(stderr, "[TwilightDiagnostics] crash capture %s failed: %lu\n", stage, code);
    const std::string body = "{\"status\":\"failed\",\"processId\":" + std::to_string(pid) +
      ",\"stage\":\"" + stage + "\",\"errorCode\":" + std::to_string(code) + "}";
    const auto temporary = ready + L".tmp";
    HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return;
    DWORD written = 0;
    const bool saved = WriteFile(file, body.data(), static_cast<DWORD>(body.size()), &written, nullptr) && written == body.size();
    CloseHandle(file);
    if (saved) MoveFileExW(temporary.c_str(), ready.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
  };
  const auto command = L"\"" + helper + L"\" --pid " + std::to_wstring(pid) +
    L" --owner " + std::to_wstring(parentProcessId(pid)) + L" --directory \"" + directory + L"\" --session " + session;
  std::vector<wchar_t> buffer(command.begin(), command.end()); buffer.push_back(0);
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(helper.c_str(), buffer.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) {
    failure("launch", GetLastError()); return;
  }
  CloseHandle(child.hThread);
  const auto deadline = GetTickCount64() + 3000;
  while (GetFileAttributesW(ready.c_str()) == INVALID_FILE_ATTRIBUTES && GetTickCount64() < deadline && WaitForSingleObject(child.hProcess, 20) == WAIT_TIMEOUT) {}
  if (GetFileAttributesW(ready.c_str()) == INVALID_FILE_ATTRIBUTES) {
    DWORD code = 0; GetExitCodeProcess(child.hProcess, &code);
    failure(code == STILL_ACTIVE ? "attach-timeout" : "collector-exit", code == STILL_ACTIVE ? ERROR_TIMEOUT : code);
  }
  CloseHandle(child.hProcess);
}
}
#endif
