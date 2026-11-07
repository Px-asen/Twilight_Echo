#include <windows.h>
#include <winsvc.h>
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE v) : value(v) {}
  ~Handle() { reset(); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  void reset(HANDLE v = nullptr) {
    if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
    value = v;
  }
};

struct Options {
  std::wstring name = L"TwilightEchoServer", node, entry, data;
  DWORD startTimeout = 180000, stopTimeout = 45000;
  bool console = false;
};
Options options;
Handle stopEvent;
volatile LONG shutdownRequested = FALSE;
SERVICE_STATUS_HANDLE serviceHandle = nullptr;
SERVICE_STATUS serviceStatus{};
SRWLOCK serviceStatusLock = SRWLOCK_INIT;
DWORD checkpoint = 0;
Handle logFile;

void log(const std::string& text) {
  SYSTEMTIME now{}; GetSystemTime(&now);
  char prefix[64];
  std::snprintf(prefix, sizeof(prefix), "%04u-%02u-%02uT%02u:%02u:%02uZ [service] ",
                now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
  const std::string line = std::string(prefix) + text + "\r\n";
  DWORD written = 0;
  if (logFile.value) WriteFile(logFile.value, line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
  if (options.console) { std::fputs(line.c_str(), stderr); std::fflush(stderr); }
}

void status(DWORD state, DWORD error = NO_ERROR, DWORD pid = 0) {
  AcquireSRWLockExclusive(&serviceStatusLock);
  serviceStatus.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  serviceStatus.dwCurrentState = state;
  serviceStatus.dwControlsAccepted = state == SERVICE_RUNNING
    ? SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN | SERVICE_ACCEPT_PRESHUTDOWN : 0;
  serviceStatus.dwWin32ExitCode = error;
  serviceStatus.dwWaitHint = state == SERVICE_START_PENDING || state == SERVICE_STOP_PENDING ? 10000 : 0;
  serviceStatus.dwCheckPoint = serviceStatus.dwWaitHint ? ++checkpoint : 0;
  if (!serviceStatus.dwWaitHint) checkpoint = 0;
  if (serviceHandle) SetServiceStatus(serviceHandle, &serviceStatus);
  ReleaseSRWLockExclusive(&serviceStatusLock);
  if (options.console) {
    const char* name = state == SERVICE_START_PENDING ? "START_PENDING" : state == SERVICE_RUNNING ? "RUNNING"
      : state == SERVICE_STOP_PENDING ? "STOP_PENDING" : "STOPPED";
    std::printf("STATE %s error=%lu pid=%lu\n", name, error, pid); std::fflush(stdout);
  }
}

// Windows CommandLineToArgvW / Node CRT quoting, including embedded quotes and trailing slashes.
std::wstring quote(const std::wstring& text) {
  std::wstring output = L"\"";
  size_t slashes = 0;
  for (wchar_t c : text) {
    if (c == L'\\') { ++slashes; continue; }
    output.append(slashes * (c == L'"' ? 2 : 1), L'\\'); slashes = 0;
    if (c == L'"') output += L'\\';
    output += c;
  }
  output.append(slashes * 2, L'\\');
  output += L'"';
  return output;
}

void failIf(bool condition, const char* operation) {
  if (condition) throw std::runtime_error(std::string(operation) + " failed (" + std::to_string(GetLastError()) + ")");
}

bool pipeLine(HANDLE pipe, std::string& pending, std::vector<std::string>& lines) {
  DWORD available = 0;
  if (!PeekNamedPipe(pipe, nullptr, 0, nullptr, &available, nullptr)) return false;
  if (!available) return true;
  char buffer[4096]; DWORD read = 0;
  if (!ReadFile(pipe, buffer, std::min<DWORD>(available, sizeof(buffer)), &read, nullptr)) return false;
  pending.append(buffer, read);
  size_t end;
  while ((end = pending.find('\n')) != std::string::npos) {
    std::string line = pending.substr(0, end); pending.erase(0, end + 1);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    lines.push_back(line);
  }
  return true;
}

bool sendStop(HANDLE input) {
  constexpr char command[] = "TWILIGHT_SERVER_STOP\n";
  DWORD written = 0;
  return WriteFile(input, command, sizeof(command) - 1, &written, nullptr) && written == sizeof(command) - 1;
}

struct ProcessHost {
  Handle job, process, input, output;
  DWORD pid = 0;
  ~ProcessHost() {
    if (job.value) {
      try { if (active()) terminate(ERROR_PROCESS_ABORTED); }
      catch (const std::exception& error) { log(std::string("Owned Job termination not confirmed: ") + error.what()); }
    }
  }
  void launch() {
    SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    Handle inputRead, outputWrite;
    HANDLE parentInput = nullptr, childInput = nullptr, parentOutput = nullptr, childOutput = nullptr;
    failIf(!CreatePipe(&childInput, &parentInput, &inheritable, 0), "CreatePipe stdin");
    inputRead.reset(childInput); input.reset(parentInput);
    failIf(!CreatePipe(&parentOutput, &childOutput, &inheritable, 0), "CreatePipe stdout");
    output.reset(parentOutput); outputWrite.reset(childOutput);
    failIf(!SetHandleInformation(input.value, HANDLE_FLAG_INHERIT, 0), "Protect parent stdin handle");
    failIf(!SetHandleInformation(output.value, HANDLE_FLAG_INHERIT, 0), "Protect parent stdout handle");
    job.reset(CreateJobObjectW(nullptr, nullptr)); failIf(!job.value, "CreateJobObject");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    failIf(!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "SetInformationJobObject");

    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inputRead.value; startup.StartupInfo.hStdOutput = outputWrite.value;
    startup.StartupInfo.hStdError = logFile.value;
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    std::vector<unsigned char> attributes(bytes);
    startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    failIf(!InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes), "Initialize handle list");
    HANDLE handles[] = {inputRead.value, outputWrite.value, logFile.value};
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr)) {
      DeleteProcThreadAttributeList(startup.lpAttributeList); failIf(true, "Restrict inherited handles");
    }
    std::wstring command = quote(options.node) + L" " + quote(options.entry) + L" service-child --data " + quote(options.data);
    PROCESS_INFORMATION info{};
    const std::wstring directory = std::filesystem::path(options.entry).parent_path().wstring();
    const BOOL created = CreateProcessW(options.node.c_str(), command.data(), nullptr, nullptr, TRUE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, directory.c_str(), &startup.StartupInfo, &info);
    const DWORD createError = GetLastError();
    DeleteProcThreadAttributeList(startup.lpAttributeList);
    if (!created) SetLastError(createError);
    failIf(!created, "CreateProcess Node");
    process.reset(info.hProcess); Handle thread(info.hThread); pid = info.dwProcessId;
    if (!AssignProcessToJobObject(job.value, process.value)) {
      const DWORD error = GetLastError(); TerminateProcess(process.value, error); WaitForSingleObject(process.value, INFINITE);
      SetLastError(error); failIf(true, "Assign Node to owned Job");
    }
    failIf(ResumeThread(thread.value) == static_cast<DWORD>(-1), "Resume Node");
    log("Started Node pid=" + std::to_string(pid));
  }
  DWORD active() const {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    failIf(!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr), "Query owned processes");
    return accounting.ActiveProcesses;
  }
  void terminate(DWORD code) {
    if (!job.value) return;
    failIf(!TerminateJobObject(job.value, code), "Terminate owned Job");
    const ULONGLONG deadline = GetTickCount64() + 5000;
    while (active() && GetTickCount64() < deadline) Sleep(20);
    failIf(active() != 0, "Confirm owned processes exited");
  }
};

DWORD run() {
  ProcessHost host;
  host.launch();
  DWORD state = SERVICE_START_PENDING;
  status(state, NO_ERROR, host.pid);
  const ULONGLONG started = GetTickCount64();
  ULONGLONG stopStarted = 0, reported = started;
  bool ready = false, stopped = false, requestedStop = false;
  std::string output, consoleInput;
  while (true) {
    std::vector<std::string> lines;
    pipeLine(host.output.value, output, lines);
    for (const auto& line : lines) {
      if (line == "TWILIGHT_SERVER_READY" && !ready) {
        ready = true; state = SERVICE_RUNNING; status(state, NO_ERROR, host.pid); log("Core and local administration ready");
      } else if (line == "TWILIGHT_SERVER_STOPPED") {
        stopped = true; log("Core persistence and owned-process checkpoint completed");
      } else if (line == "TWILIGHT_SERVER_STOP_FAILED") {
        log("Stop checkpoint failed; local administration remains available");
        if (InterlockedCompareExchange(&shutdownRequested, FALSE, FALSE)) { host.terminate(ERROR_TIMEOUT); return ERROR_TIMEOUT; }
        state = SERVICE_RUNNING; status(state, NO_ERROR, host.pid);
      } else { log("Unexpected child control line: " + line); host.terminate(ERROR_INVALID_DATA); return ERROR_INVALID_DATA; }
    }
    if (WaitForSingleObject(host.process.value, 0) == WAIT_OBJECT_0) {
      // Drain the child's final control line before judging its exit.
      lines.clear(); pipeLine(host.output.value, output, lines);
      for (const auto& line : lines) if (line == "TWILIGHT_SERVER_STOPPED") stopped = true;
      DWORD code = 1; GetExitCodeProcess(host.process.value, &code);
      const ULONGLONG deadline = GetTickCount64() + 2000;
      while (host.active() && GetTickCount64() < deadline) Sleep(20);
      const DWORD remaining = host.active();
      log("Node exited code=" + std::to_string(code) + " ownedRemaining=" + std::to_string(remaining));
      if (remaining) host.terminate(ERROR_PROCESS_ABORTED);
      return ready && stopped && code == 0 && !remaining ? NO_ERROR : ERROR_PROCESS_ABORTED;
    }
    if (options.console && GetFileType(GetStdHandle(STD_INPUT_HANDLE)) == FILE_TYPE_PIPE) {
      lines.clear();
      pipeLine(GetStdHandle(STD_INPUT_HANDLE), consoleInput, lines);
      for (const auto& line : lines) {
        if (line == "stop") SetEvent(stopEvent.value);
        else if (line == "shutdown") { InterlockedExchange(&shutdownRequested, TRUE); SetEvent(stopEvent.value); }
      }
    }
    const ULONGLONG now = GetTickCount64();
    if (ready && state == SERVICE_RUNNING && WaitForSingleObject(stopEvent.value, 0) == WAIT_OBJECT_0) {
      ResetEvent(stopEvent.value); requestedStop = true;
      state = SERVICE_STOP_PENDING; stopStarted = now; status(state, NO_ERROR, host.pid);
      if (!sendStop(host.input.value)) { host.terminate(ERROR_BROKEN_PIPE); return ERROR_BROKEN_PIPE; }
    }
    if (!ready && now - started >= options.startTimeout) {
      log("Startup deadline expired before Core readiness"); host.terminate(ERROR_SERVICE_REQUEST_TIMEOUT); return ERROR_SERVICE_REQUEST_TIMEOUT;
    }
    if (state == SERVICE_STOP_PENDING && now - stopStarted >= options.stopTimeout) {
      log("Stop deadline expired; checkpoint not acknowledged");
      if (InterlockedCompareExchange(&shutdownRequested, FALSE, FALSE)) { host.terminate(ERROR_TIMEOUT); return ERROR_TIMEOUT; }
      state = SERVICE_RUNNING; status(state, NO_ERROR, host.pid);
    }
    if (state != SERVICE_RUNNING && now - reported >= 1000) { status(state, NO_ERROR, host.pid); reported = now; }
    // A local admin stop is also authoritative; the child sends STOPPED and exits.
    if (stopped && !requestedStop && state == SERVICE_RUNNING) { state = SERVICE_STOP_PENDING; stopStarted = now; status(state, NO_ERROR, host.pid); }
    Sleep(20);
  }
}

DWORD WINAPI control(DWORD code, DWORD, LPVOID, LPVOID) {
  if (code == SERVICE_CONTROL_STOP || code == SERVICE_CONTROL_SHUTDOWN || code == SERVICE_CONTROL_PRESHUTDOWN) {
    if (code != SERVICE_CONTROL_STOP) InterlockedExchange(&shutdownRequested, TRUE);
    SetEvent(stopEvent.value); return NO_ERROR;
  }
  if (code == SERVICE_CONTROL_INTERROGATE) {
    AcquireSRWLockShared(&serviceStatusLock);
    if (serviceHandle) SetServiceStatus(serviceHandle, &serviceStatus);
    ReleaseSRWLockShared(&serviceStatusLock);
    return NO_ERROR;
  }
  return ERROR_CALL_NOT_IMPLEMENTED;
}

DWORD execute() {
  try { return run(); }
  catch (const std::exception& error) { log(error.what()); return ERROR_PROCESS_ABORTED; }
}
void WINAPI serviceMain(DWORD, LPWSTR*) {
  serviceHandle = RegisterServiceCtrlHandlerExW(options.name.c_str(), control, nullptr);
  if (!serviceHandle) { log("RegisterServiceCtrlHandlerEx failed"); return; }
  status(SERVICE_START_PENDING);
  status(SERVICE_STOPPED, execute());
}
BOOL WINAPI consoleControl(DWORD code) {
  if (code == CTRL_C_EVENT || code == CTRL_BREAK_EVENT || code == CTRL_CLOSE_EVENT) { SetEvent(stopEvent.value); return TRUE; }
  return FALSE;
}

Options parse(int argc, wchar_t** argv) {
  Options result;
  for (int i = 1; i < argc; ++i) {
    const std::wstring key = argv[i];
    if (key == L"--console") { result.console = true; continue; }
    if (i + 1 >= argc) throw std::runtime_error("Missing service host argument");
    const std::wstring value = argv[++i];
    if (key == L"--node") result.node = value;
    else if (key == L"--entry") result.entry = value;
    else if (key == L"--data") result.data = value;
    else if (key == L"--service-name") result.name = value;
    else if (key == L"--start-timeout-ms") result.startTimeout = static_cast<DWORD>(std::stoul(value));
    else if (key == L"--stop-timeout-ms") result.stopTimeout = static_cast<DWORD>(std::stoul(value));
    else throw std::runtime_error("Unknown service host argument");
  }
  if (result.name.empty() || result.name.find_first_of(L"\\/\r\n") != std::wstring::npos ||
      result.node.empty() || result.entry.empty() || result.data.empty() ||
      !std::filesystem::path(result.node).is_absolute() || !std::filesystem::path(result.entry).is_absolute() ||
      !std::filesystem::path(result.data).is_absolute() || !result.startTimeout || !result.stopTimeout)
    throw std::runtime_error("Usage: twilight-server-service [--console] --node ABSOLUTE_NODE --entry ABSOLUTE_SERVER --data ABSOLUTE_PROFILE [--service-name NAME]");
  return result;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    options = parse(argc, argv);
    const auto path = std::filesystem::path(options.data) / L"server-service.log";
    SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    logFile.reset(CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
      &inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
    failIf(logFile.value == INVALID_HANDLE_VALUE, "Open service log");
    stopEvent.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr)); failIf(!stopEvent.value, "Create stop event");
    if (options.console) {
      SetConsoleCtrlHandler(consoleControl, TRUE);
      const DWORD error = execute(); status(SERVICE_STOPPED, error); return error == NO_ERROR ? 0 : 1;
    }
    SERVICE_TABLE_ENTRYW table[] = {{options.name.data(), serviceMain}, {nullptr, nullptr}};
    failIf(!StartServiceCtrlDispatcherW(table), "StartServiceCtrlDispatcher (run --console outside SCM)");
    return serviceStatus.dwWin32ExitCode == NO_ERROR ? 0 : 1;
  } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
