#include "Vst3ModuleProbe.h"
#include "Vst3Runtime.h"
#include "Vst3SharedProtocol.h"

#include <windows.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

using SharedMemory = twilight::vst3::ipc::SharedMemory;
using HostState = twilight::vst3::ipc::HostState;
using SlotState = twilight::vst3::ipc::SlotState;

struct ServeArguments {
  std::wstring sharedMemory;
  std::wstring inputEvent;
  std::wstring modulePath;
  std::wstring classId;
  std::wstring statePath;
  std::wstring stateFormat;
};

struct RenderTestArguments {
  std::wstring modulePath;
  std::wstring classId;
  std::wstring statePath;
  std::wstring stateFormat;
  uint32_t sampleRate = 48000;
  uint32_t channels = 2;
};

std::string utf8(const wchar_t* value) {
  if (!value || !*value) return {};
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
  if (count <= 1) return {};
  std::vector<char> output(static_cast<size_t>(count));
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, output.data(), count, nullptr, nullptr);
  return std::string(output.data(), static_cast<size_t>(count - 1));
}

std::string utf8(const std::wstring& value) {
  return utf8(value.c_str());
}

LONG readAtomic(const volatile int32_t* value) {
  return InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(const_cast<int32_t*>(value)), 0, 0);
}

LONG compareExchange(volatile int32_t* value, LONG desired, LONG expected) {
  return InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(value), desired, expected);
}

void writeAtomic(volatile int32_t* value, LONG next) {
  InterlockedExchange(reinterpret_cast<volatile LONG*>(value), next);
}

void writeStatusMessage(SharedMemory* shared, const std::string& message) {
  if (!shared) return;
  std::memset(shared->statusMessage, 0, sizeof(shared->statusMessage));
  const size_t count = std::min(message.size(), sizeof(shared->statusMessage) - 1);
  if (count > 0) std::memcpy(shared->statusMessage, message.data(), count);
}

void publishFailure(SharedMemory* shared, const std::string& message, LONG code = 1) {
  if (!shared) return;
  writeStatusMessage(shared, message.empty() ? "The VST3 host failed" : message);
  writeAtomic(&shared->hostErrorCode, code);
  MemoryBarrier();
  writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Failed));
}

bool supportedChannelCount(uint32_t channels) {
  return channels == 1 || channels == 2 || channels == 6 || channels == 8;
}

bool parseServeArguments(int argc, wchar_t* argv[], ServeArguments* result, std::string* error) {
  if (!result) return false;
  for (int index = 2; index < argc; index += 2) {
    if (index + 1 >= argc) {
      if (error) *error = "VST3 host option is missing a value";
      return false;
    }
    const std::wstring_view key(argv[index]);
    const std::wstring value(argv[index + 1]);
    if (key == L"--shared-memory") {
      result->sharedMemory = value;
    } else if (key == L"--input-event") {
      result->inputEvent = value;
    } else if (key == L"--module") {
      result->modulePath = value;
    } else if (key == L"--class-id") {
      result->classId = value;
    } else if (key == L"--state") {
      result->statePath = value;
    } else if (key == L"--state-format") {
      result->stateFormat = value;
    } else {
      if (error) *error = "Unsupported VST3 host option";
      return false;
    }
  }
  if (result->sharedMemory.empty() || result->inputEvent.empty() || result->modulePath.empty() || result->classId.empty()) {
    if (error) *error = "VST3 host requires shared memory, input event, module, and class ID";
    return false;
  }
  if (result->statePath.empty() != result->stateFormat.empty() ||
      (!result->stateFormat.empty() && result->stateFormat != L"preset" && result->stateFormat != L"componentState")) {
    if (error) *error = "VST3 state options require a preset or componentState format";
    return false;
  }
  return true;
}

bool parseUnsigned(const std::wstring& value, uint32_t* result) {
  if (!result || value.empty()) return false;
  wchar_t* end = nullptr;
  const unsigned long parsed = std::wcstoul(value.c_str(), &end, 10);
  if (end != value.c_str() + value.size() || parsed > UINT32_MAX) return false;
  *result = static_cast<uint32_t>(parsed);
  return true;
}

bool parseRenderTestArguments(int argc, wchar_t* argv[], RenderTestArguments* result, std::string* error) {
  if (!result) return false;
  for (int index = 2; index < argc; index += 2) {
    if (index + 1 >= argc) {
      if (error) *error = "VST3 render-test option is missing a value";
      return false;
    }
    const std::wstring_view key(argv[index]);
    const std::wstring value(argv[index + 1]);
    if (key == L"--module") {
      result->modulePath = value;
    } else if (key == L"--class-id") {
      result->classId = value;
    } else if (key == L"--state") {
      result->statePath = value;
    } else if (key == L"--state-format") {
      result->stateFormat = value;
    } else if (key == L"--sample-rate") {
      if (!parseUnsigned(value, &result->sampleRate)) {
        if (error) *error = "VST3 render-test sample rate is invalid";
        return false;
      }
    } else if (key == L"--channels") {
      if (!parseUnsigned(value, &result->channels)) {
        if (error) *error = "VST3 render-test channel count is invalid";
        return false;
      }
    } else {
      if (error) *error = "Unsupported VST3 render-test option";
      return false;
    }
  }
  if (result->modulePath.empty() || result->classId.empty() || result->sampleRate == 0 ||
      !supportedChannelCount(result->channels)) {
    if (error) *error = "VST3 render-test requires a module, class ID, sample rate, and supported channel layout";
    return false;
  }
  if (result->statePath.empty() != result->stateFormat.empty() ||
      (!result->stateFormat.empty() && result->stateFormat != L"preset" && result->stateFormat != L"componentState")) {
    if (error) *error = "VST3 state options require a preset or componentState format";
    return false;
  }
  return true;
}

int serve(const ServeArguments& arguments) {
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, arguments.sharedMemory.c_str());
  if (!mapping) return 2;
  auto* shared = static_cast<SharedMemory*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedMemory)));
  if (!shared) {
    CloseHandle(mapping);
    return 2;
  }
  auto cleanup = [&] {
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
  };
  if (shared->magic != twilight::vst3::ipc::kProtocolMagic || shared->version != twilight::vst3::ipc::kProtocolVersion ||
      shared->maxFrames == 0 || shared->maxFrames > twilight::vst3::ipc::kMaxFrames ||
      !supportedChannelCount(shared->channels) || shared->sampleRate == 0 ||
      shared->parameterJsonLength >= twilight::vst3::ipc::kMaxParameterJsonBytes) {
    publishFailure(shared, "The VST3 host received an invalid shared-memory protocol payload", 2);
    cleanup();
    return 2;
  }

  HANDLE inputEvent = OpenEventW(SYNCHRONIZE | EVENT_MODIFY_STATE, FALSE, arguments.inputEvent.c_str());
  if (!inputEvent) {
    publishFailure(shared, "The VST3 host could not open its input event", 3);
    cleanup();
    return 2;
  }

  twilight::vst3::RuntimeConfig config;
  config.modulePath = utf8(arguments.modulePath);
  config.classId = utf8(arguments.classId);
  config.sampleRate = shared->sampleRate;
  config.channels = shared->channels;
  config.maxFrames = shared->maxFrames;
  config.parametersJson.assign(shared->parameterJson, shared->parameterJsonLength);
  config.statePath = utf8(arguments.statePath);
  config.stateFormat = utf8(arguments.stateFormat);

  twilight::vst3::Vst3Runtime runtime;
  if (!runtime.initialize(config)) {
    publishFailure(shared, runtime.info().error, 4);
    CloseHandle(inputEvent);
    cleanup();
    return 2;
  }
  shared->pluginLatencyFrames = runtime.info().latencyFrames;
  shared->pluginTailFrames = runtime.info().tailFrames;
  writeStatusMessage(shared, "");
  writeAtomic(&shared->hostErrorCode, 0);
  MemoryBarrier();
  writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Ready));

  bool failed = false;
  while (readAtomic(&shared->hostState) == static_cast<LONG>(HostState::Ready)) {
    const DWORD wait = WaitForSingleObject(inputEvent, 250);
    if (wait == WAIT_FAILED) {
      publishFailure(shared, "The VST3 host input event wait failed", 5);
      failed = true;
      break;
    }
    InterlockedIncrement(reinterpret_cast<volatile LONG*>(&shared->hostHeartbeat));
    if (readAtomic(&shared->hostState) != static_cast<LONG>(HostState::Ready)) break;

    for (uint32_t processed = 0; processed < twilight::vst3::ipc::kSlotCount; ++processed) {
      twilight::vst3::ipc::AudioSlot* next = nullptr;
      for (auto& candidate : shared->slots) {
        if (readAtomic(&candidate.state) != static_cast<LONG>(SlotState::Ready)) continue;
        if (!next || static_cast<int32_t>(candidate.sequence - next->sequence) < 0) next = &candidate;
      }
      if (!next) break;
      auto& slot = *next;
      if (compareExchange(
              &slot.state,
              static_cast<LONG>(SlotState::Processing),
              static_cast<LONG>(SlotState::Ready)) != static_cast<LONG>(SlotState::Ready)) {
        continue;
      }
      if (slot.frames == 0 || slot.frames > shared->maxFrames || slot.channels != shared->channels) {
        const uint32_t safeFrames = std::min(slot.frames, shared->maxFrames);
        const size_t sampleCount = static_cast<size_t>(safeFrames) * shared->channels;
        std::memcpy(slot.output, slot.input, sampleCount * sizeof(float));
        MemoryBarrier();
        writeAtomic(&slot.state, static_cast<LONG>(SlotState::OutputReady));
        publishFailure(shared, "The VST3 host received an invalid audio slot", 6);
        failed = true;
        break;
      }
      if (!runtime.process(slot.input, slot.output, slot.frames)) {
        const size_t sampleCount = static_cast<size_t>(slot.frames) * slot.channels;
        std::memcpy(slot.output, slot.input, sampleCount * sizeof(float));
        MemoryBarrier();
        writeAtomic(&slot.state, static_cast<LONG>(SlotState::OutputReady));
        publishFailure(shared, runtime.info().error, 7);
        failed = true;
        break;
      }
      shared->pluginLatencyFrames = runtime.info().latencyFrames;
      shared->pluginTailFrames = runtime.info().tailFrames;
      MemoryBarrier();
      writeAtomic(&slot.state, static_cast<LONG>(SlotState::OutputReady));
    }
    if (failed) break;
  }

  runtime.shutdown();
  if (!failed && readAtomic(&shared->hostState) != static_cast<LONG>(HostState::Failed)) {
    writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Stopped));
  }
  CloseHandle(inputEvent);
  cleanup();
  return failed ? 2 : 0;
}

int renderTest(const RenderTestArguments& arguments) {
  constexpr uint32_t frames = 256;
  twilight::vst3::RuntimeConfig config;
  config.modulePath = utf8(arguments.modulePath);
  config.classId = utf8(arguments.classId);
  config.sampleRate = arguments.sampleRate;
  config.channels = arguments.channels;
  config.maxFrames = frames;
  config.parametersJson = "{}";
  config.statePath = utf8(arguments.statePath);
  config.stateFormat = utf8(arguments.stateFormat);
  twilight::vst3::Vst3Runtime runtime;
  if (!runtime.initialize(config)) {
    std::cerr << runtime.info().error;
    return 2;
  }
  std::vector<float> input(static_cast<size_t>(frames) * arguments.channels, 0.0f);
  std::vector<float> output(input.size(), 0.0f);
  for (uint32_t channel = 0; channel < arguments.channels; ++channel) {
    input[channel] = 0.25f;
  }
  if (!runtime.process(input.data(), output.data(), frames)) {
    std::cerr << runtime.info().error;
    return 2;
  }
  const bool outputFinite = std::all_of(output.begin(), output.end(), [](float sample) {
    return std::isfinite(sample);
  });
  if (!outputFinite) {
    std::cerr << "VST3 render-test produced non-finite audio";
    return 2;
  }
  float outputPeak = 0.0f;
  uint32_t nonSilentSamples = 0;
  for (const float sample : output) {
    const float magnitude = std::abs(sample);
    outputPeak = std::max(outputPeak, magnitude);
    if (magnitude > 1.0e-7f) ++nonSilentSamples;
  }
  std::cout << "{\"status\":\"processed\",\"frames\":" << frames << ",\"channels\":"
            << arguments.channels << ",\"latencyFrames\":" << runtime.info().latencyFrames
            << ",\"tailFrames\":" << runtime.info().tailFrames << ",\"outputPeak\":" << outputPeak
            << ",\"nonSilentSamples\":" << nonSilentSamples << "}";
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc == 2 && std::wstring_view(argv[1]) == L"--self-test") {
    std::cout << "{\"kind\":\"twilight-vst3-host\",\"protocolVersion\":"
              << twilight::vst3::ipc::kProtocolVersion << ",\"status\":\"ready\"}";
    return 0;
  }
  if (argc == 3 && std::wstring_view(argv[1]) == L"--inspect") {
    const auto result = twilight::vst3::probeModule(utf8(argv[2]));
    std::cout << twilight::vst3::hostInspectionJson(result);
    return result.ok() ? 0 : 2;
  }
  if (argc >= 2 && std::wstring_view(argv[1]) == L"--serve") {
    ServeArguments arguments;
    std::string error;
    if (!parseServeArguments(argc, argv, &arguments, &error)) {
      std::cerr << error;
      return 64;
    }
    return serve(arguments);
  }
  if (argc >= 2 && std::wstring_view(argv[1]) == L"--render-test") {
    RenderTestArguments arguments;
    std::string error;
    if (!parseRenderTestArguments(argc, argv, &arguments, &error)) {
      std::cerr << error;
      return 64;
    }
    return renderTest(arguments);
  }
  std::cerr << "Usage: twilight-vst3-host --self-test | --inspect <module-path> | --render-test "
               "--module <path> --class-id <id> [--sample-rate <hz>] [--channels <count>] "
               "[--state <path> --state-format <preset|componentState>] | --serve "
               "--shared-memory <name> --input-event <name> --module <path> --class-id <id> "
               "[--state <path> --state-format <preset|componentState>]";
  return 64;
}
