#include <windows.h>
#include <dbghelp.h>
#include <tlhelp32.h>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <iomanip>
#include <map>
#include <cstdio>
#include "CrashCaptureRegistration.h"

namespace fs = std::filesystem;
namespace {
std::string utf8(const std::wstring& value) {
  const int length = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  std::string result(length, 0);
  WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
  return result;
}
std::string quote(const std::string& value) {
  std::string result = "\"";
  for (const unsigned char ch : value) {
    if (ch == '\\' || ch == '"') { result += '\\'; result += ch; }
    else if (ch == '\n') result += "\\n";
    else if (ch == '\r') result += "\\r";
    else if (ch >= 32) result += ch;
  }
  return result + '"';
}
std::string hex(uint64_t value) { std::ostringstream out; out << "0x" << std::hex << value; return out.str(); }
std::string timestamp() {
  SYSTEMTIME t; GetSystemTime(&t); char text[40];
  std::snprintf(text, sizeof(text), "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
  return text;
}
void write(const fs::path& path, const std::string& body) {
  auto temporary = path; temporary += L".tmp";
  { std::ofstream file(temporary, std::ios::binary | std::ios::trunc); file << body; if (!file) throw std::runtime_error("evidence write failed"); }
  if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("evidence rename failed");
}
std::string moduleList(DWORD pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
  if (snapshot == INVALID_HANDLE_VALUE) return "{\"status\":\"failed\",\"errorCode\":" + std::to_string(GetLastError()) + "}";
  MODULEENTRY32W entry{}; entry.dwSize = sizeof(entry); std::string result = "["; bool first = true;
  if (Module32FirstW(snapshot, &entry)) do {
    if (!first) result += ','; first = false;
    std::string version;
    DWORD unused = 0, bytes = GetFileVersionInfoSizeW(entry.szExePath, &unused);
    if (bytes) {
      std::vector<char> data(bytes);
      if (GetFileVersionInfoW(entry.szExePath, 0, bytes, data.data())) {
        VS_FIXEDFILEINFO* info = nullptr; UINT size = 0;
        if (VerQueryValueW(data.data(), L"\\", reinterpret_cast<void**>(&info), &size) && info)
          version = std::to_string(HIWORD(info->dwFileVersionMS)) + '.' + std::to_string(LOWORD(info->dwFileVersionMS)) + '.' + std::to_string(HIWORD(info->dwFileVersionLS)) + '.' + std::to_string(LOWORD(info->dwFileVersionLS));
      }
    }
    result += "{\"name\":" + quote(utf8(entry.szModule)) + ",\"path\":" + quote(utf8(entry.szExePath)) +
      ",\"baseAddress\":" + quote(hex(reinterpret_cast<uintptr_t>(entry.modBaseAddr))) + ",\"size\":" + std::to_string(entry.modBaseSize) + ",\"version\":" + quote(version) + "}";
  } while (Module32NextW(snapshot, &entry));
  CloseHandle(snapshot); return result + ']';
}
}

int wmain(int argc, wchar_t** argv) {
  if (argc == 7 && std::wstring(argv[1]) == L"--symbolize" && std::wstring(argv[3]) == L"--offset" && std::wstring(argv[5]) == L"--symbols") {
    HANDLE process = GetCurrentProcess();
    SymSetOptions(SYMOPT_LOAD_LINES | SYMOPT_UNDNAME | SYMOPT_FAIL_CRITICAL_ERRORS | SYMOPT_NO_PROMPTS);
    if (!SymInitializeW(process, argv[6], FALSE)) return 3;
    const auto base = SymLoadModuleExW(process, nullptr, argv[2], nullptr, 0x10000000, 0, nullptr, 0);
    const auto address = base + wcstoull(argv[4], nullptr, 16);
    char storage[sizeof(SYMBOL_INFO) + MAX_SYM_NAME]{};
    auto* symbol = reinterpret_cast<SYMBOL_INFO*>(storage); symbol->SizeOfStruct = sizeof(SYMBOL_INFO); symbol->MaxNameLen = MAX_SYM_NAME;
    DWORD64 displacement = 0; IMAGEHLP_LINE64 line{}; line.SizeOfStruct = sizeof(line); DWORD lineOffset = 0;
    if (!base || !SymFromAddr(process, address, &displacement, symbol)) { SymCleanup(process); return 4; }
    std::printf("%s + %llu\n", symbol->Name, displacement);
    if (SymGetLineFromAddr64(process, address, &lineOffset, &line)) std::printf("%s:%lu\n", line.FileName, line.LineNumber);
    SymCleanup(process); return 0;
  }
  DWORD pid = 0, owner = 0; fs::path directory; std::wstring session;
  for (int i = 1; i + 1 < argc; i += 2) {
    std::wstring key = argv[i], value = argv[i + 1];
    if (key == L"--pid") pid = wcstoul(value.c_str(), nullptr, 10);
    else if (key == L"--owner") owner = wcstoul(value.c_str(), nullptr, 10);
    else if (key == L"--directory") directory = value;
    else if (key == L"--session") session = value;
    else return 64;
  }
  // A target registers itself. A caller cannot nominate an unrelated PID.
  if (!pid || !owner || session.empty() ||
      twilight::diagnostics::parentProcessId(GetCurrentProcessId()) != pid ||
      twilight::diagnostics::environment(L"TWILIGHT_DEBUG_SESSION_ID") != session ||
      fs::path(twilight::diagnostics::environment(L"TWILIGHT_DEBUG_DIRECTORY")) / L"crashes" != directory) {
    std::fprintf(stderr, "[TwilightDiagnostics] rejected crash registration: target=%lu caller=%lu sessionMatch=%d directoryMatch=%d\n",
      pid, twilight::diagnostics::parentProcessId(GetCurrentProcessId()),
      twilight::diagnostics::environment(L"TWILIGHT_DEBUG_SESSION_ID") == session,
      fs::path(twilight::diagnostics::environment(L"TWILIGHT_DEBUG_DIRECTORY")) / L"crashes" == directory);
    return 65;
  }
  const auto receipt = directory / (L"attach-" + std::to_wstring(pid) + L".json");
  const auto failure = [&](const char* stage, DWORD code) {
    std::fprintf(stderr, "[TwilightDiagnostics] %s failed: %lu\n", stage, code);
    try { write(receipt, "{\"status\":\"failed\",\"processId\":" + std::to_string(pid) +
      ",\"stage\":" + quote(stage) + ",\"errorCode\":" + std::to_string(code) + "}"); } catch (...) {}
  };
  HANDLE target = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, pid);
  if (!target) { failure("open-process", GetLastError()); return 66; }
  wchar_t executable[32768]{}; DWORD size = 32768;
  if (!QueryFullProcessImageNameW(target, 0, executable, &size)) {
    failure("process-identity", GetLastError()); CloseHandle(target); return 66;
  }
  std::wstring name = fs::path(executable).filename();
  if (name != L"node.exe" && name != L"twilight-asio-helper.exe" && name != L"twilight-asio-helper-x86.exe" &&
      name != L"twilight-vst3-host.exe" && name != L"twilight-vst3-scanner.exe" && name != L"twilight-crash-fixture.exe") { failure("process-identity", ERROR_ACCESS_DENIED); CloseHandle(target); return 65; }
  const char* stage = "attach";
  DEBUG_EVENT pendingEvent{};
  bool eventPending = false;
  DWORD pendingDisposition = DBG_CONTINUE;
  try {
    if (!DebugActiveProcess(pid)) {
      failure("attach", GetLastError()); CloseHandle(target); return 1;
    }
    DebugSetProcessKillOnExit(FALSE);
    bool attached = false, initialBreakpoint = true, alive = true;
    size_t moduleSequence = 0;
    while (alive) {
      DEBUG_EVENT event{};
      if (!WaitForDebugEvent(&event, 1000)) { if (WaitForSingleObject(target, 0) == WAIT_OBJECT_0) break; continue; }
      DWORD disposition = DBG_CONTINUE;
      pendingEvent = event; eventPending = true; pendingDisposition = DBG_CONTINUE;
      stage = "module-inventory";
      if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
        CloseHandle(event.u.CreateProcessInfo.hFile);
        CloseHandle(event.u.CreateProcessInfo.hThread); CloseHandle(event.u.CreateProcessInfo.hProcess);
      } else if (event.dwDebugEventCode == CREATE_THREAD_DEBUG_EVENT) CloseHandle(event.u.CreateThread.hThread);
      else if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) CloseHandle(event.u.LoadDll.hFile);
      else if (event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) alive = false;
      if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT || event.dwDebugEventCode == UNLOAD_DLL_DEBUG_EVENT || event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
        // The latest complete module inventory survives the target's exit.
        write(directory / (L"modules-" + std::to_wstring(pid) + L".json"),
          "{\"timestamp\":" + quote(timestamp()) + ",\"processId\":" + std::to_string(pid) + ",\"revision\":" + std::to_string(++moduleSequence) + ",\"modules\":" + moduleList(pid) + "}");
      }
      if (event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
        auto& exception = event.u.Exception;
        if (initialBreakpoint && exception.ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT) initialBreakpoint = false;
        else {
          disposition = DBG_EXCEPTION_NOT_HANDLED;
          pendingDisposition = disposition;
          if (!exception.dwFirstChance) {
            stage = "minidump";
            const auto stem = L"crash-" + std::to_wstring(pid) + L"-" + std::to_wstring(GetTickCount64());
            const auto dump = directory / (stem + L".dmp"), partial = directory / (stem + L".dmp.tmp");
            const auto mutexName = L"Local\\TwilightDebugDump-" + session;
            HANDLE mutex = CreateMutexW(nullptr, FALSE, mutexName.c_str());
            const DWORD locked = WaitForSingleObject(mutex, 3000);
            DWORD error = 0; bool saved = false;
            if (locked == WAIT_OBJECT_0 || locked == WAIT_ABANDONED) {
              size_t dumpCount = 0; uint64_t total = 0;
              for (const auto& file : fs::recursive_directory_iterator(directory.parent_path())) if (file.is_regular_file()) {
                total += file.file_size(); if (file.path().extension() == L".dmp") ++dumpCount;
              }
              if (dumpCount < 3 && total < 1024ULL * 1024 * 1024 && !fs::exists(directory.parent_path() / L"capacity-reached")) {
                HANDLE thread = OpenThread(THREAD_GET_CONTEXT | THREAD_QUERY_INFORMATION, FALSE, event.dwThreadId);
                CONTEXT context{}; context.ContextFlags = CONTEXT_ALL;
                if (thread && GetThreadContext(thread, &context)) {
                  EXCEPTION_POINTERS pointers{ &exception.ExceptionRecord, &context };
                  MINIDUMP_EXCEPTION_INFORMATION info{ event.dwThreadId, &pointers, FALSE };
                  HANDLE file = CreateFileW(partial.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
                  if (file != INVALID_HANDLE_VALUE) {
                    saved = MiniDumpWriteDump(target, pid, file,
                      static_cast<MINIDUMP_TYPE>(MiniDumpNormal | MiniDumpWithThreadInfo | MiniDumpWithUnloadedModules), &info, nullptr, nullptr) != FALSE;
                    error = saved ? 0 : GetLastError(); CloseHandle(file);
                    if (saved && !MoveFileExW(partial.c_str(), dump.c_str(), MOVEFILE_WRITE_THROUGH)) { saved = false; error = GetLastError(); }
                    if (!saved) DeleteFileW(partial.c_str());
                  } else error = GetLastError();
                } else error = GetLastError();
                if (thread) CloseHandle(thread);
              } else error = ERROR_DISK_FULL;
              ReleaseMutex(mutex);
            } else error = ERROR_TIMEOUT;
            CloseHandle(mutex);
            stage = "crash-report";
            write(directory / (stem + L".json"), "{\"timestamp\":" + quote(timestamp()) + ",\"debugSessionId\":" + quote(utf8(session)) +
              ",\"processId\":" + std::to_string(pid) + ",\"threadId\":" + std::to_string(event.dwThreadId) +
              ",\"exceptionCode\":" + quote(hex(exception.ExceptionRecord.ExceptionCode)) + ",\"exceptionAddress\":" + quote(hex(reinterpret_cast<uintptr_t>(exception.ExceptionRecord.ExceptionAddress))) +
              ",\"dumpStatus\":" + quote(saved ? "saved" : "failed") + ",\"stage\":\"minidump\",\"errorCode\":" + std::to_string(error) + ",\"modules\":" + moduleList(pid) + "}");
          }
        }
      }
      ContinueDebugEvent(event.dwProcessId, event.dwThreadId, disposition);
      eventPending = false;
      if (!attached && !initialBreakpoint) {
        write(receipt, "{\"status\":\"attached\",\"processId\":" + std::to_string(pid) + ",\"architecture\":" + quote(sizeof(void*) == 8 ? "x64" : "x86") + "}"); attached = true;
      }
    }
    DebugActiveProcessStop(pid); CloseHandle(target); return 0;
  } catch (...) {
    const DWORD error = GetLastError();
    if (eventPending) ContinueDebugEvent(pendingEvent.dwProcessId, pendingEvent.dwThreadId, pendingDisposition);
    DebugActiveProcessStop(pid);
    failure(stage, error ? error : ERROR_WRITE_FAULT);
    CloseHandle(target); return 2;
  }
}
