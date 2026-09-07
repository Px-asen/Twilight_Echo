#include "Vst3BridgeProcessor.h"

#include "../vst3/Vst3SharedProtocol.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <string_view>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

namespace twilight::audio {

std::atomic<size_t> Vst3BridgeProcessor::liveInstanceCount_{0};
namespace {

#ifdef _WIN32
using SharedMemory = twilight::vst3::ipc::SharedMemory;
using HostState = twilight::vst3::ipc::HostState;
using SlotState = twilight::vst3::ipc::SlotState;

std::atomic<uint64_t> g_bridgeSerial{1};

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

std::string windowsError(DWORD error) {
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

std::wstring quoteWindowsArgument(const std::wstring& value) {
  std::wstring quoted;
  quoted.reserve(value.size() + 2);
  quoted.push_back(L'"');
  size_t slashCount = 0;
  for (wchar_t character : value) {
    if (character == L'\\') {
      ++slashCount;
      continue;
    }
    if (character == L'"') {
      quoted.append(slashCount * 2 + 1, L'\\');
      quoted.push_back(character);
      slashCount = 0;
      continue;
    }
    quoted.append(slashCount, L'\\');
    slashCount = 0;
    quoted.push_back(character);
  }
  quoted.append(slashCount * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

std::wstring hostExecutablePath(std::string* error) {
  HMODULE module = nullptr;
  if (!GetModuleHandleExW(
          GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
          reinterpret_cast<LPCWSTR>(hostExecutablePath),
          &module)) {
    if (error) *error = "Unable to locate audio engine module: " + windowsError(GetLastError());
    return {};
  }
  std::array<wchar_t, 32768> path{};
  const DWORD length = GetModuleFileNameW(module, path.data(), static_cast<DWORD>(path.size()));
  if (length == 0 || length >= path.size() - 1) {
    if (error) *error = "Unable to locate audio engine directory: " + windowsError(GetLastError());
    return {};
  }
  std::wstring modulePath(path.data(), length);
  const size_t separator = modulePath.find_last_of(L"\\/");
  if (separator == std::wstring::npos) {
    if (error) *error = "Unable to locate the VST3 host directory";
    return {};
  }
  return modulePath.substr(0, separator + 1) + L"twilight-vst3-host.exe";
}

LONG readAtomic(const volatile int32_t* value) {
  return InterlockedCompareExchange(reinterpret_cast<volatile LONG*>(const_cast<int32_t*>(value)), 0, 0);
}

void writeAtomic(volatile int32_t* value, LONG next) {
  InterlockedExchange(reinterpret_cast<volatile LONG*>(value), next);
}

std::string sharedStatusMessage(const SharedMemory* shared) {
  if (!shared) return {};
  const size_t length = strnlen(shared->statusMessage, twilight::vst3::ipc::kMaxStatusMessageBytes);
  return std::string(shared->statusMessage, length);
}
#endif

bool isSupportedChannelCount(int channelCount) {
  return channelCount == 1 || channelCount == 2 || channelCount == 6 || channelCount == 8;
}

}  // namespace

Vst3BridgeProcessor::Vst3BridgeProcessor(Vst3BridgeConfig config) : bridgeConfig_(std::move(config)) {
  liveInstanceCount_.fetch_add(1, std::memory_order_relaxed);
  slotFramePositions_.fill(UINT64_MAX);
}

Vst3BridgeProcessor::~Vst3BridgeProcessor() {
  destroyHost();
  liveInstanceCount_.fetch_sub(1, std::memory_order_relaxed);
}

size_t Vst3BridgeProcessor::liveInstanceCountForTests() noexcept {
  return liveInstanceCount_.load(std::memory_order_relaxed);
}

void Vst3BridgeProcessor::configure(const DspConfig& config) {
  dspConfig_ = config;
}

void Vst3BridgeProcessor::prepare(const AudioFormat& format) {
  const bool formatChanged = format.sampleRate != format_.sampleRate || format.channelCount != format_.channelCount;
  format_ = format;
  if (formatChanged || !active_.load(std::memory_order_acquire)) {
    destroyHost();
    if (!launchHost()) return;
  }
}

void Vst3BridgeProcessor::setTrackContext(const DspTrackContext& context) {
  trackContext_ = context;
}

void Vst3BridgeProcessor::process(float* samples, size_t frameCount) {
  if (!samples || frameCount == 0 || !active_.load(std::memory_order_acquire)) return;
  if (!isSupportedChannelCount(format_.channelCount)) return;
  const uint32_t channels = static_cast<uint32_t>(format_.channelCount);
  size_t offset = 0;
  while (offset < frameCount) {
    const uint32_t count = static_cast<uint32_t>(std::min<size_t>(
        twilight::vst3::ipc::kMaxFrames, frameCount - offset));
    processBlock(samples + offset * channels, count);
    offset += count;
  }
}

void Vst3BridgeProcessor::reset() {
  inputFramePosition_ = 0;
  slotFramePositions_.fill(UINT64_MAX);
  delayedSamples_.fill(0.0f);
}

bool Vst3BridgeProcessor::isActive() const {
#ifdef _WIN32
  const auto* shared = static_cast<const SharedMemory*>(sharedMemory_);
  const HANDLE process = static_cast<HANDLE>(hostProcessHandle_);
  return active_.load(std::memory_order_acquire) && shared &&
         readAtomic(&shared->hostState) == static_cast<LONG>(HostState::Ready) &&
         (!process || WaitForSingleObject(process, 0) == WAIT_TIMEOUT);
#else
  return false;
#endif
}

std::string Vst3BridgeProcessor::bypassReason() const {
#ifdef _WIN32
  if (!lastError_.empty()) return lastError_;
  const auto* shared = static_cast<const SharedMemory*>(sharedMemory_);
  const HANDLE process = static_cast<HANDLE>(hostProcessHandle_);
  if (shared && readAtomic(&shared->hostState) == static_cast<LONG>(HostState::Failed)) {
    const std::string reason = sharedStatusMessage(shared);
    if (!reason.empty()) return reason;
  }
  if (process && WaitForSingleObject(process, 0) == WAIT_OBJECT_0) {
    return "The isolated VST3 host crashed or exited";
  }
#endif
  return "VST3 host is unavailable";
}

uint32_t Vst3BridgeProcessor::latencyFrames() const noexcept {
#ifdef _WIN32
  const auto* shared = static_cast<const SharedMemory*>(sharedMemory_);
  return shared ? shared->pluginLatencyFrames + kDelayFrames : 0;
#else
  return 0;
#endif
}

uint32_t Vst3BridgeProcessor::tailFrames() const noexcept {
#ifdef _WIN32
  const auto* shared = static_cast<const SharedMemory*>(sharedMemory_);
  return shared ? shared->pluginTailFrames : 0;
#else
  return 0;
#endif
}

void Vst3BridgeProcessor::setFailure(const std::string& message) {
  active_.store(false, std::memory_order_release);
  lastError_ = message.empty() ? "VST3 host is unavailable" : message;
}

bool Vst3BridgeProcessor::launchHost() {
#ifndef _WIN32
  setFailure("VST3 hosting is supported only on Windows x64");
  return false;
#else
  if (bridgeConfig_.modulePath.empty() || bridgeConfig_.classId.empty()) {
    setFailure("VST3 graph nodes require a resolved module path and class ID");
    return false;
  }
  if (format_.sampleRate <= 0 || !isSupportedChannelCount(format_.channelCount)) {
    setFailure("VST3 host requires a Mono, Stereo, 5.1, or 7.1 PCM format");
    return false;
  }
  if (bridgeConfig_.parametersJson.size() >= twilight::vst3::ipc::kMaxParameterJsonBytes) {
    setFailure("VST3 parameter payload exceeds the managed host limit");
    return false;
  }
  if (bridgeConfig_.statePath.empty() != bridgeConfig_.stateFormat.empty() ||
      (!bridgeConfig_.stateFormat.empty() && bridgeConfig_.stateFormat != "preset" &&
       bridgeConfig_.stateFormat != "componentState")) {
    setFailure("VST3 state assets require a managed preset or component-state format");
    return false;
  }

  const uint64_t serial = g_bridgeSerial.fetch_add(1, std::memory_order_relaxed);
  const std::wstring suffix = std::to_wstring(GetCurrentProcessId()) + L"_" + std::to_wstring(serial);
  const std::wstring mappingName = L"Local\\TwilightEchoVst3Map_" + suffix;
  const std::wstring eventName = L"Local\\TwilightEchoVst3Input_" + suffix;
  HANDLE mapping = CreateFileMappingW(
      INVALID_HANDLE_VALUE,
      nullptr,
      PAGE_READWRITE,
      0,
      static_cast<DWORD>(sizeof(SharedMemory)),
      mappingName.c_str());
  if (!mapping) {
    setFailure("Unable to create VST3 shared memory: " + windowsError(GetLastError()));
    return false;
  }
  auto* shared = static_cast<SharedMemory*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(SharedMemory)));
  if (!shared) {
    const std::string message = windowsError(GetLastError());
    CloseHandle(mapping);
    setFailure("Unable to map VST3 shared memory: " + message);
    return false;
  }
  std::memset(shared, 0, sizeof(*shared));
  shared->magic = twilight::vst3::ipc::kProtocolMagic;
  shared->version = twilight::vst3::ipc::kProtocolVersion;
  shared->sampleRate = static_cast<uint32_t>(format_.sampleRate);
  shared->channels = static_cast<uint32_t>(format_.channelCount);
  shared->maxFrames = twilight::vst3::ipc::kMaxFrames;
  shared->parameterJsonLength = static_cast<uint32_t>(bridgeConfig_.parametersJson.size());
  std::memcpy(shared->parameterJson, bridgeConfig_.parametersJson.data(), bridgeConfig_.parametersJson.size());
  writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Initializing));

  HANDLE inputEvent = CreateEventW(nullptr, FALSE, FALSE, eventName.c_str());
  if (!inputEvent) {
    const std::string message = windowsError(GetLastError());
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    setFailure("Unable to create VST3 input event: " + message);
    return false;
  }

  std::string helperError;
  const std::wstring hostPath = hostExecutablePath(&helperError);
  if (hostPath.empty() || GetFileAttributesW(hostPath.c_str()) == INVALID_FILE_ATTRIBUTES) {
    CloseHandle(inputEvent);
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    setFailure(hostPath.empty() ? helperError : "The isolated VST3 host helper is missing beside the audio engine");
    return false;
  }
  const std::wstring modulePath = utf8ToWide(bridgeConfig_.modulePath);
  const std::wstring classId = utf8ToWide(bridgeConfig_.classId);
  if (modulePath.empty() || classId.empty()) {
    CloseHandle(inputEvent);
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    setFailure("VST3 module path or class ID is not valid UTF-8");
    return false;
  }
  std::wstring command = quoteWindowsArgument(hostPath) + L" --serve --shared-memory " +
      quoteWindowsArgument(mappingName) + L" --input-event " + quoteWindowsArgument(eventName) +
      L" --module " + quoteWindowsArgument(modulePath) + L" --class-id " + quoteWindowsArgument(classId);
  if (!bridgeConfig_.statePath.empty()) {
    const std::wstring statePath = utf8ToWide(bridgeConfig_.statePath);
    const std::wstring stateFormat = utf8ToWide(bridgeConfig_.stateFormat);
    if (statePath.empty() || stateFormat.empty()) {
      CloseHandle(inputEvent);
      UnmapViewOfFile(shared);
      CloseHandle(mapping);
      setFailure("VST3 state asset path is not valid UTF-8");
      return false;
    }
    command += L" --state " + quoteWindowsArgument(statePath) + L" --state-format " +
        quoteWindowsArgument(stateFormat);
  }
  std::vector<wchar_t> commandBuffer(command.begin(), command.end());
  commandBuffer.push_back(L'\0');
  const size_t slash = hostPath.find_last_of(L"\\/");
  const std::wstring hostDirectory = hostPath.substr(0, slash);
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION process{};
  if (!CreateProcessW(
          hostPath.c_str(),
          commandBuffer.data(),
          nullptr,
          nullptr,
          FALSE,
          CREATE_NO_WINDOW,
          nullptr,
          hostDirectory.c_str(),
          &startup,
          &process)) {
    const std::string message = windowsError(GetLastError());
    CloseHandle(inputEvent);
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    setFailure("Unable to launch the isolated VST3 host: " + message);
    return false;
  }
  CloseHandle(process.hThread);

  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (std::chrono::steady_clock::now() < deadline) {
    const LONG state = readAtomic(&shared->hostState);
    if (state == static_cast<LONG>(HostState::Ready)) {
      mappingHandle_ = mapping;
      inputEventHandle_ = inputEvent;
      hostProcessHandle_ = process.hProcess;
      sharedMemory_ = shared;
      lastError_.clear();
      nextSequence_ = 0;
      reset();
      processCalls_.store(0, std::memory_order_relaxed);
      overrunCount_.store(0, std::memory_order_relaxed);
      active_.store(true, std::memory_order_release);
      return true;
    }
    if (state == static_cast<LONG>(HostState::Failed) || WaitForSingleObject(process.hProcess, 0) == WAIT_OBJECT_0) {
      const std::string message = sharedStatusMessage(shared);
      CloseHandle(process.hProcess);
      CloseHandle(inputEvent);
      UnmapViewOfFile(shared);
      CloseHandle(mapping);
      setFailure(message.empty() ? "The isolated VST3 host exited during startup" : message);
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Stopping));
  SetEvent(inputEvent);
  TerminateProcess(process.hProcess, 0xC000013A);
  CloseHandle(process.hProcess);
  CloseHandle(inputEvent);
  UnmapViewOfFile(shared);
  CloseHandle(mapping);
  setFailure("The isolated VST3 host did not become ready within 5 seconds");
  return false;
#endif
}

void Vst3BridgeProcessor::destroyHost() {
#ifdef _WIN32
  auto* shared = static_cast<SharedMemory*>(sharedMemory_);
  HANDLE process = static_cast<HANDLE>(hostProcessHandle_);
  HANDLE inputEvent = static_cast<HANDLE>(inputEventHandle_);
  if (shared) writeAtomic(&shared->hostState, static_cast<LONG>(HostState::Stopping));
  if (inputEvent) SetEvent(inputEvent);
  if (process) {
    if (WaitForSingleObject(process, 500) == WAIT_TIMEOUT) {
      TerminateProcess(process, 0xC000013A);
      WaitForSingleObject(process, 500);
    }
    CloseHandle(process);
  }
  if (inputEvent) CloseHandle(inputEvent);
  if (shared) UnmapViewOfFile(shared);
  if (mappingHandle_) CloseHandle(static_cast<HANDLE>(mappingHandle_));
#endif
  mappingHandle_ = nullptr;
  inputEventHandle_ = nullptr;
  hostProcessHandle_ = nullptr;
  sharedMemory_ = nullptr;
  active_.store(false, std::memory_order_release);
}

void Vst3BridgeProcessor::storeDelayedFrames(
    uint64_t firstFrame, const float* samples, uint32_t frameCount) noexcept {
  const size_t channels = static_cast<size_t>(format_.channelCount);
  const size_t offset = firstFrame % kBufferedFrames;
  const size_t firstCount = std::min<size_t>(frameCount, kBufferedFrames - offset);
  std::memcpy(delayedSamples_.data() + offset * channels, samples, firstCount * channels * sizeof(float));
  std::memcpy(delayedSamples_.data(), samples + firstCount * channels,
      (frameCount - firstCount) * channels * sizeof(float));
}

void Vst3BridgeProcessor::readDelayedFrames(
    uint64_t firstFrame, float* samples, uint32_t frameCount) noexcept {
  const size_t channels = static_cast<size_t>(format_.channelCount);
  const size_t offset = firstFrame % kBufferedFrames;
  const size_t firstCount = std::min<size_t>(frameCount, kBufferedFrames - offset);
  std::memcpy(samples, delayedSamples_.data() + offset * channels, firstCount * channels * sizeof(float));
  std::memcpy(samples + firstCount * channels, delayedSamples_.data(),
      (frameCount - firstCount) * channels * sizeof(float));
}

void Vst3BridgeProcessor::processBlock(float* samples, uint32_t frameCount) noexcept {
#ifndef _WIN32
  (void)samples;
  (void)frameCount;
#else
  auto* shared = static_cast<SharedMemory*>(sharedMemory_);
  HANDLE inputEvent = static_cast<HANDLE>(inputEventHandle_);
  HANDLE process = static_cast<HANDLE>(hostProcessHandle_);
  if (!shared || !inputEvent || !process || readAtomic(&shared->hostState) != static_cast<LONG>(HostState::Ready) ||
      WaitForSingleObject(process, 0) != WAIT_TIMEOUT) {
    active_.store(false, std::memory_order_release);
    return;
  }
  const uint32_t channels = static_cast<uint32_t>(format_.channelCount);
  const size_t sampleCount = static_cast<size_t>(frameCount) * channels;
  const uint64_t outputPosition = inputFramePosition_ > kDelayFrames ? inputFramePosition_ - kDelayFrames : 0;
  for (uint32_t index = 0; index < kSlotCount; ++index) {
    auto& slot = shared->slots[index];
    if (readAtomic(&slot.state) != static_cast<LONG>(SlotState::OutputReady)) continue;
    const uint64_t position = slotFramePositions_[index];
    if (position != UINT64_MAX) {
      const uint32_t consumed = static_cast<uint32_t>(std::min<uint64_t>(
          slot.frames, outputPosition > position ? outputPosition - position : 0));
      if (consumed > 0) overrunCount_.fetch_add(1, std::memory_order_relaxed);
      if (consumed < slot.frames) {
        storeDelayedFrames(position + consumed, slot.output + static_cast<size_t>(consumed) * channels,
            slot.frames - consumed);
      }
    }
    slotFramePositions_[index] = UINT64_MAX;
    writeAtomic(&slot.state, static_cast<LONG>(SlotState::Empty));
  }

  storeDelayedFrames(inputFramePosition_, samples, frameCount);
  bool submitted = false;
  for (uint32_t index = 0; index < kSlotCount; ++index) {
    auto& slot = shared->slots[index];
    if (readAtomic(&slot.state) != static_cast<LONG>(SlotState::Empty)) continue;
    std::memcpy(slot.input, samples, sampleCount * sizeof(float));
    slot.sequence = nextSequence_++;
    slot.frames = frameCount;
    slot.channels = channels;
    slotFramePositions_[index] = inputFramePosition_;
    MemoryBarrier();
    writeAtomic(&slot.state, static_cast<LONG>(SlotState::Ready));
    SetEvent(inputEvent);
    submitted = true;
    break;
  }
  if (!submitted) overrunCount_.fetch_add(1, std::memory_order_relaxed);

  const uint32_t silenceFrames = inputFramePosition_ < kDelayFrames ?
      static_cast<uint32_t>(std::min<uint64_t>(frameCount, kDelayFrames - inputFramePosition_)) : 0;
  std::memset(samples, 0, static_cast<size_t>(silenceFrames) * channels * sizeof(float));
  if (silenceFrames < frameCount) {
    readDelayedFrames(inputFramePosition_ + silenceFrames - kDelayFrames,
        samples + static_cast<size_t>(silenceFrames) * channels, frameCount - silenceFrames);
  }
  inputFramePosition_ += frameCount;
  processCalls_.fetch_add(1, std::memory_order_relaxed);
#endif
}

}  // namespace twilight::audio
