#include "Vst3BridgeProcessor.h"
#include "../vst3/Vst3SharedProtocol.h"

#include <windows.h>

#include <algorithm>
#include <cassert>
#include <cstring>
#include <iostream>
#include <memory>
#include <string>
#include <vector>

using namespace twilight::audio;
using namespace twilight::vst3::ipc;

LONG readState(volatile int32_t* state) {
  return InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(state), 0, 0);
}

void writeState(volatile int32_t* state, LONG value) {
  InterlockedExchange(reinterpret_cast<volatile LONG*>(state), value);
}

std::string largeParameters() {
  std::string json = "{";
  for (uint32_t index = 0; index < kMaxParameters; ++index) {
    if (index) json += ',';
    json += '"' + std::to_string(UINT32_MAX - index) + "\":0.12345678901234567";
  }
  return json + '}';
}

int serve(int argc, wchar_t* argv[]) {
  std::wstring mappingName;
  std::wstring eventName;
  std::wstring completionName;
  for (int index = 2; index + 1 < argc; index += 2) {
    if (std::wstring(argv[index]) == L"--shared-memory") mappingName = argv[index + 1];
    if (std::wstring(argv[index]) == L"--input-event") eventName = argv[index + 1];
    if (std::wstring(argv[index]) == L"--module") completionName = argv[index + 1];
  }
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mappingName.c_str());
  assert(mapping);
  auto* shared = static_cast<SharedMemory*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedMemory)));
  assert(shared);
  HANDLE event = OpenEventW(SYNCHRONIZE, FALSE, eventName.c_str());
  assert(event);
  HANDLE completion = OpenEventW(EVENT_MODIFY_STATE, FALSE, completionName.c_str());
  assert(completion);
  HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE,
      std::stoul(completionName.substr(completionName.find_last_of(L'_') + 1)));
  assert(parent);
  const std::string expected = largeParameters();
  assert(shared->version == kProtocolVersion);
  assert(shared->parameterJsonLength == expected.size());
  assert(std::memcmp(shared->parameterJson, expected.data(), expected.size()) == 0);
  shared->reservedAtomic = static_cast<int32_t>(GetCurrentProcessId());
  writeState(&shared->hostState, static_cast<LONG>(HostState::Ready));
  while (readState(&shared->hostState) == static_cast<LONG>(HostState::Ready)) {
    const HANDLE waits[] = {parent, event};
    if (WaitForMultipleObjects(2, waits, FALSE, 10) == WAIT_OBJECT_0) break;
    for (auto& slot : shared->slots) {
      if (InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(&slot.state),
              static_cast<LONG>(SlotState::Processing), static_cast<LONG>(SlotState::Ready)) !=
          static_cast<LONG>(SlotState::Ready)) continue;
      for (size_t index = 0; index < static_cast<size_t>(slot.frames) * slot.channels; ++index) {
        slot.output[index] = slot.input[index] * 0.25f;
      }
      writeState(&slot.state, static_cast<LONG>(SlotState::OutputReady));
      SetEvent(completion);
    }
  }
  CloseHandle(event);
  CloseHandle(completion);
  CloseHandle(parent);
  UnmapViewOfFile(shared);
  CloseHandle(mapping);
  return 0;
}

int wmain(int argc, wchar_t* argv[]) {
  if (argc > 1 && std::wstring(argv[1]) == L"--serve") return serve(argc, argv);
  if (argc == 3 && std::wstring(argv[1]) == L"--abandon-owner") {
    const std::wstring name(argv[2]);
    const std::string completionName(name.begin(), name.end());
    auto bridge = std::make_unique<Vst3BridgeProcessor>(Vst3BridgeConfig{
        "owner-exit", completionName, "0123456789ABCDEF0123456789ABCDEF", largeParameters(), "", ""});
    bridge->prepare({48000, 2, 32});
    if (!bridge->isActive()) return 1;
    HANDLE ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, (name + L"_ready").c_str());
    HANDLE exit = OpenEventW(SYNCHRONIZE, FALSE, (name + L"_exit").c_str());
    assert(ready && exit);
    SetEvent(ready);
    if (WaitForSingleObject(exit, 5000) != WAIT_OBJECT_0) return 1;
    // Match an abrupt audio-service exit: no bridge destructor runs.
    ExitProcess(0);
  }
  const std::string parameters = largeParameters();
  assert(parameters.size() > 8192);
  const std::string completionName = "Local\\TwilightVst3Regression_" + std::to_string(GetCurrentProcessId());
  HANDLE completion = CreateEventA(nullptr, FALSE, FALSE, completionName.c_str());
  assert(completion);
  auto bridge = std::make_unique<Vst3BridgeProcessor>(Vst3BridgeConfig{
      "capacity-test", completionName, "0123456789ABCDEF0123456789ABCDEF", parameters, "", ""});
  bridge->prepare({48000, 2, 32});
  if (!bridge->isActive()) {
    std::cerr << bridge->bypassReason();
    return 1;
  }
  assert(bridge->latencyFrames() == kMaxFrames);
  const uint32_t sizes[] = {256, 480, 128, 512, 63, 960, 100, 4096};
  std::vector<float> samples(kMaxFrames * 2);
  const auto signal = [](uint64_t frame, uint32_t channel) {
    return static_cast<float>((frame * 2 + channel) % 100003 + 1) / 100004.0f;
  };
  for (int pass = 0; pass < 2; ++pass) {
    uint64_t position = 0;
    for (int block = 0; block < 48; ++block) {
      const uint32_t frames = sizes[block % 8];
      for (uint32_t frame = 0; frame < frames; ++frame) {
        for (uint32_t channel = 0; channel < 2; ++channel) {
          samples[frame * 2 + channel] = signal(position + frame, channel);
        }
      }
      bridge->process(samples.data(), frames);
      assert(WaitForSingleObject(completion, 2000) == WAIT_OBJECT_0);
      for (uint32_t frame = 0; frame < frames; ++frame) {
        for (uint32_t channel = 0; channel < 2; ++channel) {
          const float expected = position + frame < kMaxFrames ? 0.0f :
              signal(position + frame - kMaxFrames, channel) * 0.25f;
          assert(samples[frame * 2 + channel] == expected);
        }
      }
      assert(bridge->latencyFrames() == kMaxFrames);
      position += frames;
    }
    bridge->reset();
  }
  assert(bridge->overrunCount() == 0);
  bridge.reset();
  CloseHandle(completion);
  auto oversized = std::make_unique<Vst3BridgeProcessor>(Vst3BridgeConfig{
      "oversized-test", "fixture.vst3", "0123456789ABCDEF0123456789ABCDEF",
      std::string(kMaxParameterJsonBytes, ' '), "", ""});
  oversized->prepare({48000, 2, 32});
  assert(!oversized->isActive());
  assert(oversized->bypassReason().find("parameter payload exceeds") != std::string::npos);
  {
    const std::wstring name = L"Local\\TwilightVst3OwnerRegression_" + std::to_wstring(GetCurrentProcessId());
    HANDLE completion = CreateEventW(nullptr, FALSE, FALSE, name.c_str());
    HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, (name + L"_ready").c_str());
    HANDLE exit = CreateEventW(nullptr, FALSE, FALSE, (name + L"_exit").c_str());
    assert(completion && ready && exit);
    wchar_t executable[32768]{};
    assert(GetModuleFileNameW(nullptr, executable, 32768));
    std::wstring command = L"\"" + std::wstring(executable) + L"\" --abandon-owner " + name;
    STARTUPINFOW startup{}; startup.cb = sizeof(startup);
    PROCESS_INFORMATION owner{};
    assert(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
        nullptr, nullptr, &startup, &owner));
    CloseHandle(owner.hThread);
    const HANDLE waits[] = {ready, owner.hProcess};
    assert(WaitForMultipleObjects(2, waits, FALSE, 5000) == WAIT_OBJECT_0);
    const std::wstring mappingName = L"Local\\TwilightEchoVst3Map_" + std::to_wstring(owner.dwProcessId) + L"_1";
    HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, mappingName.c_str());
    assert(mapping);
    const auto* shared = static_cast<const SharedMemory*>(MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, sizeof(SharedMemory)));
    assert(shared);
    HANDLE host = OpenProcess(SYNCHRONIZE | PROCESS_TERMINATE, FALSE, static_cast<DWORD>(shared->reservedAtomic));
    assert(host);
    UnmapViewOfFile(shared); CloseHandle(mapping);
    SetEvent(exit);
    assert(WaitForSingleObject(owner.hProcess, 5000) == WAIT_OBJECT_0);
    const DWORD hostExit = WaitForSingleObject(host, 3000);
    if (hostExit != WAIT_OBJECT_0) { TerminateProcess(host, 1); WaitForSingleObject(host, 1000); }
    CloseHandle(host); CloseHandle(owner.hProcess);
    CloseHandle(completion); CloseHandle(ready); CloseHandle(exit);
    assert(hostExit == WAIT_OBJECT_0);
  }
  std::cout << "Transferred " << parameters.size() << " parameter bytes and received processed audio\n";
  std::cout << "VST3 helper exited with its audio-service owner\n";
  return 0;
}
