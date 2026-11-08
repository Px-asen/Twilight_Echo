#include "../AsioHelperHost.h"
#include "AsioHelperProcess.h"
#include "../DeviceCapabilityCache.h"

#include <Windows.h>

#include <array>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace {

using namespace std::chrono_literals;
using twilight::audio::AsioChannelFormat;
using twilight::audio::AsioHelperHost;
using twilight::audio::AsioHostEvent;
using twilight::audio::AsioOpenConfig;
using twilight::audio::AsioOpenFailureKind;
using twilight::audio::AsioOpenResult;
using twilight::audio::AudioSampleFormat;
using twilight::audio::asio_helper::AsioHelperProcess;
using twilight::audio::asio_helper::Command;
using twilight::audio::asio_helper::FailureReason;
using twilight::audio::asio_helper::Response;

bool waitUntil(const std::function<bool()>& condition, std::chrono::milliseconds timeout) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (std::chrono::steady_clock::now() < deadline) {
    if (condition()) return true;
    std::this_thread::sleep_for(5ms);
  }
  return condition();
}

void setMode(const wchar_t* mode) {
  assert(SetEnvironmentVariableW(L"TAE_ASIO_HELPER_FIXTURE_MODE", mode));
}

AsioOpenConfig openConfig() {
  AsioOpenConfig config;
  config.deviceId = "asio:fixture";
  config.format.sampleRate = 48000;
  config.format.channelCount = 2;
  config.format.bitDepth = 32;
  config.format.sampleFormat = AudioSampleFormat::Float32Interleaved;
  config.bufferSizeFrames = 64;
  return config;
}

bool requestOpen(AsioHelperProcess* process, Response* response, std::string* error) {
  const AsioOpenConfig config = openConfig();
  return process->request(
      Command::Open,
      [&](twilight::audio::asio_helper::Request& request) {
        twilight::audio::asio_helper::copyText(
            request.deviceId, sizeof(request.deviceId), config.deviceId);
        request.format = twilight::audio::asio_helper::encodeAudioFormat(config.format);
        request.bufferSizeFrames = static_cast<int32_t>(config.bufferSizeFrames);
      },
      response,
      2s,
      error);
}

void testNormalRoundTrip(const std::wstring& helperPath) {
  setMode(L"normal");
  AsioHelperProcess process(helperPath);
  std::string error;
  assert(process.launch(&error));
  assert(!process.waitForCallbacks(0));
  process.wakeCallbacks();
  assert(process.waitForCallbacks(1000));
  assert(!process.waitForCallbacks(0));

  Response response;
  assert(process.request(Command::EnumerateDevices, &response, 2s, &error));
  assert(response.deviceCount == 1);
  assert(response.devices[0].capabilityVersion == 0x1122334455667788ULL);
  assert(twilight::audio::asio_helper::readText(response.devices[0].id) == "asio:fixture");
  assert(requestOpen(&process, &response, &error));
  assert(response.openFailureKind == static_cast<int32_t>(AsioOpenFailureKind::None));
  assert(process.request(Command::CreateBuffers, &response, 2s, &error));
  assert(response.channelCount == 2);
  assert(response.bufferSizeFrames == 64);
  assert(process.request(Command::Start, &response, 2s, &error));
  assert(process.waitForCallbacks(2000));

  auto* shared = process.shared();
  assert(shared);
  assert(waitUntil(
      [&] { return twilight::audio::asio_helper::readAtomic(&shared->callbackWriteSequence) > 0; },
      2s));
  const auto callback = shared->callbacks[0];
  assert(callback.bufferIndex >= 0 && callback.bufferIndex <= 1);
  auto& buffer = shared->buffers[callback.bufferIndex];
  std::memset(
      twilight::audio::asio_helper::channelBuffer(shared, 0, callback.bufferIndex),
      0x2a,
      64 * sizeof(float));
  std::memset(
      twilight::audio::asio_helper::channelBuffer(shared, 1, callback.bufferIndex),
      0x5a,
      64 * sizeof(float));
  buffer.committedFrames = 64;
  buffer.channelBytes[0] = 64 * sizeof(float);
  buffer.channelBytes[1] = 64 * sizeof(float);
  MemoryBarrier();
  const LONG generation = twilight::audio::asio_helper::incrementAtomic(&buffer.generation);
  assert(waitUntil(
      [&] {
        return twilight::audio::asio_helper::readAtomic(&buffer.consumedGeneration) == generation;
      },
      2s));
  assert(process.request(Command::Stop, &response, 2s, &error));
  assert(process.request(Command::Close, &response, 2s, &error));
  process.shutdown();
}

void testControlTimeout(const std::wstring& helperPath) {
  setMode(L"control-timeout");
  AsioHelperProcess process(helperPath);
  std::string error;
  assert(process.launch(&error));
  Response response;
  assert(!process.request(Command::GetDiagnostics, &response, 100ms, &error));
  assert(error.starts_with("asio_helper_control_timeout"));
  assert(waitUntil([&] { return !process.alive(); }, 2s));
}

void testNativeDsdQueuePreservesOrderWithoutParentWakeups(const std::wstring& helperPath) {
  using namespace twilight::audio::asio_helper;
  setMode(L"verify-dsd-queue");
  AsioHelperProcess process(helperPath);
  std::string error;
  assert(process.launch(&error));
  Response response;
  assert(process.request(Command::Open, [](Request& request) {
    copyText(request.deviceId, sizeof(request.deviceId), "asio:fixture");
    auto config = openConfig();
    config.format.sampleRate = 2822400;
    config.format.bitDepth = 1;
    config.format.sampleFormat = AudioSampleFormat::DsdInt8Msb1;
    request.format = encodeAudioFormat(config.format);
    request.bufferSizeFrames = 64;
  }, &response, 2s, &error));
  assert(process.request(Command::CreateBuffers, &response, 2s, &error));
  auto* shared = process.shared();
  assert(shared->renderQueueCapacity == kRenderQueueSlots);
  assert(!queuedChannelBuffer(shared, 0, 2));
  for (uint32_t sequence = 0; sequence < 8; ++sequence) {
    auto& block = shared->renderQueueBlocks[sequence];
    block.committedFrames = 8;
    for (uint32_t channel = 0; channel < 2; ++channel) {
      block.channelBytes[channel] = 8;
      std::memset(queuedChannelBuffer(shared, sequence, channel), sequence + 1, 8);
    }
    MemoryBarrier();
    exchangeAtomic(&shared->renderQueueWrite, sequence + 1);
  }
  assert(process.request(Command::Start, &response, 2s, &error));
  // Intentionally do not drain callbacks or replenish the queue. Two driver
  // buffers alone cannot sustain these eight distinct, ordered audio blocks.
  assert(waitUntil([&] { return readAtomic(&shared->hostEventWriteSequence) >= 8; }, 2s));
  assert(process.request(Command::Stop, &response, 2s, &error));
  for (uint32_t sequence = 0; sequence < 8; ++sequence)
    assert(readText(shared->hostEvents[sequence].message) == "dsd-queue-verified");
  assert(readAtomic(&shared->renderQueueRead) == 8);
  assert(process.request(Command::Close, &response, 2s, &error));
  process.shutdown();
}

void testWireCapacityAndFloat64(const std::wstring& helperPath) {
  using namespace twilight::audio::asio_helper;
  for (const wchar_t* mode : {L"verify-float64", L"verify-bounds"}) {
    setMode(mode);
    AsioHelperProcess process(helperPath);
    std::string error;
    Response response;
    assert(process.launch(&error));
    assert(requestOpen(&process, &response, &error));
    assert(process.request(Command::CreateBuffers, &response, 2s, &error));
    assert(response.actualFormat.sampleRate == 48000 && response.latencyFrames == 77);
    assert(readText(response.startupSummary) == "fixture post-create summary");
    auto* shared = process.shared();
    assert(readAtomic(&shared->activeRenderFrameCapacity) == 64);
    auto& block = shared->buffers[0];
    const bool wide = std::wstring(mode) == L"verify-float64";
    block.committedFrames = wide ? 64 : 80;
    for (long channel = 0; channel < 2; ++channel) {
      auto* output = channelBuffer(shared, channel, 0);
      if (wide) for (size_t i = 0; i < 64; ++i) {
        const double sample = channel == 0 ? 0.25 : -0.5;
        std::memcpy(output + i * 8, &sample, 8);
      }
      else std::memset(output, 0x5a, 320);
      block.channelBytes[channel] = wide ? 512 : 320;
    }
    MemoryBarrier(); incrementAtomic(&block.generation);
    assert(process.request(Command::Start, &response, 2s, &error));
    assert(waitUntil([&] { return readAtomic(&shared->hostEventWriteSequence) > 0; }, 2s));
    assert(readText(shared->hostEvents[0].message) == "wire-verified");
    assert(shared->callbacks[0].driverTimestampNs > 0);
    assert(process.request(Command::Stop, &response, 2s, &error));
    process.shutdown();
  }
}

void testAbnormalExit(const std::wstring& helperPath) {
  setMode(L"abnormal-exit");
  AsioHelperProcess process(helperPath);
  std::string error;
  assert(process.launch(&error));
  Response response;
  assert(!process.request(Command::GetDiagnostics, &response, 2s, &error));
  assert(error.starts_with("asio_helper_process_exited"));
  assert(!process.alive());
}

void testExternalKill(const std::wstring& helperPath) {
  setMode(L"normal");
  AsioHelperProcess process(helperPath);
  std::string error;
  assert(process.launch(&error));
  HANDLE child = OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, FALSE, process.processId());
  assert(child);
  assert(TerminateProcess(child, 92));
  assert(WaitForSingleObject(child, 2000) == WAIT_OBJECT_0);
  CloseHandle(child);
  Response response;
  assert(!process.request(Command::GetDiagnostics, &response, 100ms, &error));
  assert(error.starts_with("asio_helper_process_exited"));
}

void testDeviceReject(const std::wstring& helperPath) {
  setMode(L"device-reject");
  AsioHelperProcess process(helperPath);
  std::string error;
  assert(process.launch(&error));
  Response response;
  assert(!requestOpen(&process, &response, &error));
  assert(response.failureReason == static_cast<int32_t>(FailureReason::DeviceRejected));
  assert(response.openFailureKind == static_cast<int32_t>(AsioOpenFailureKind::Driver));
  assert(error.starts_with("asio_helper_device_rejected"));
  process.shutdown();
}

void testFormatRestoreFailure(const std::wstring& helperPath) {
  setMode(L"restore-failure");
  AsioHelperProcess process(helperPath);
  std::string error;
  assert(process.launch(&error));
  Response response;
  assert(requestOpen(&process, &response, &error));
  assert(!process.request(Command::Close, &response, 2s, &error));
  assert(response.failureReason == static_cast<int32_t>(FailureReason::FormatRestoreFailed));
  assert(error.starts_with("asio_helper_format_restore_failed"));
  process.shutdown();
}

void testOpenRestoreFailurePoisonsTheHelper(const std::wstring& helperPath) {
  setMode(L"open-restore-failure");
  AsioHelperHost host(helperPath);
  std::string error;
  AsioOpenResult result;
  assert(!host.open(openConfig(), &result, &error));
  assert(error.starts_with("asio_helper_format_restore_failed"));
  assert(result.failureKind == AsioOpenFailureKind::Driver);
  assert(!host.outputReady());
  error.clear();
  assert(!host.open(openConfig(), &result, &error));
  assert(error.starts_with("asio_helper_format_restore_failed"));
}

void testMalformedOpenFailsClosed(const std::wstring& helperPath) {
  setMode(L"normal");
  AsioHelperProcess process(helperPath);
  std::string error;
  assert(process.launch(&error));
  Response response;
  assert(!process.request(
      Command::Open,
      [](twilight::audio::asio_helper::Request& request) {
        twilight::audio::asio_helper::copyText(
            request.deviceId, sizeof(request.deviceId), "asio:fixture");
        request.format = twilight::audio::asio_helper::encodeAudioFormat(openConfig().format);
        request.format.sampleFormat = 999;
        request.bufferSizeFrames = 64;
      },
      &response,
      2s,
      &error));
  assert(response.failureReason == static_cast<int32_t>(FailureReason::ProtocolError));
  assert(error.starts_with("asio_helper_protocol_error"));
  assert(waitUntil([&] { return !process.alive(); }, 2s));
}

void testCallbackWatchdog(const std::wstring& helperPath) {
  setMode(L"callback-stop");
  AsioHelperHost host(helperPath);
  std::string error;
  AsioOpenResult result;
  assert(host.open(openConfig(), &result, &error));
  std::atomic<bool> failed{false};
  std::string failure;
  assert(host.createBuffers(
      [&](long bufferIndex) {
        for (long channel = 0; channel < 2; ++channel) {
          auto* output = static_cast<uint8_t*>(host.outputBuffer(channel, bufferIndex));
          assert(output);
          std::memset(output, 0, 64 * sizeof(float));
        }
        host.commitOutputBuffer(bufferIndex, 64);
      },
      [&](AsioHostEvent event, const std::string& message) {
        if (event != AsioHostEvent::HelperFailure) return;
        failure = message;
        failed.store(true, std::memory_order_release);
      },
      &error));
  assert(host.start(&error));
  assert(waitUntil([&] { return failed.load(std::memory_order_acquire); }, 5s));
  assert(failure.starts_with("asio_helper_callback_stalled"));
  assert(!host.outputReady());
  host.close();
}

void testStopTimeoutRemainsObservable(const std::wstring& helperPath) {
  setMode(L"stop-timeout");
  AsioHelperHost host(helperPath);
  std::string error;
  AsioOpenResult result;
  assert(host.open(openConfig(), &result, &error));
  assert(host.createBuffers(
      [&](long bufferIndex) {
        for (long channel = 0; channel < 2; ++channel) {
          auto* output = static_cast<uint8_t*>(host.outputBuffer(channel, bufferIndex));
          assert(output);
          std::memset(output, 0, 64 * sizeof(float));
        }
        host.commitOutputBuffer(bufferIndex, 64);
      },
      [](AsioHostEvent, const std::string&) {},
      &error));
  assert(host.start(&error));
  host.stop();
  assert(!host.outputReady());
  assert(host.lastCloseError().starts_with("asio_helper_control_timeout"));
  host.close();
  assert(host.lastCloseError().starts_with("asio_helper_control_timeout"));
}

void testCallbackBacklogDoesNotOverwritePendingGeneration(const std::wstring& helperPath) {
  setMode(L"callback-backlog");
  AsioHelperHost host(helperPath);
  std::string error;
  AsioOpenResult result;
  assert(host.open(openConfig(), &result, &error));
  std::atomic<int> callbackCount{0};
  assert(host.createBuffers(
      [&](long bufferIndex) {
        callbackCount.fetch_add(1, std::memory_order_acq_rel);
        std::this_thread::sleep_for(50ms);
        for (long channel = 0; channel < 2; ++channel) {
          auto* output = static_cast<uint8_t*>(host.outputBuffer(channel, bufferIndex));
          assert(output);
          std::memset(output, 0x31, 64 * sizeof(float));
        }
        host.commitOutputBuffer(bufferIndex, 64);
      },
      [](AsioHostEvent, const std::string&) {},
      &error));
  assert(host.start(&error));
  assert(waitUntil([&] { return callbackCount.load(std::memory_order_acquire) >= 1; }, 2s));
  std::this_thread::sleep_for(150ms);
  assert(callbackCount.load(std::memory_order_acquire) == 1);
  const auto health = host.renderHealth();
  assert(health.callbackCount == 3);
  assert(health.underrunCount == 3);
  assert(health.bufferDropCount == 2);
  host.close();
}

void testDelayedStartResetsCallbackWatchdog(const std::wstring& helperPath) {
  setMode(L"delayed-callback");
  AsioHelperHost host(helperPath);
  std::string error;
  AsioOpenResult result;
  assert(host.open(openConfig(), &result, &error));
  std::atomic<int> callbackCount{0};
  std::atomic<bool> failed{false};
  assert(host.createBuffers(
      [&](long bufferIndex) {
        callbackCount.fetch_add(1, std::memory_order_acq_rel);
        for (long channel = 0; channel < 2; ++channel) {
          auto* output = static_cast<uint8_t*>(host.outputBuffer(channel, bufferIndex));
          assert(output);
          std::memset(output, 0, 64 * sizeof(float));
        }
        host.commitOutputBuffer(bufferIndex, 64);
      },
      [&](AsioHostEvent event, const std::string&) {
        if (event == AsioHostEvent::HelperFailure) {
          failed.store(true, std::memory_order_release);
        }
      },
      &error));
  std::this_thread::sleep_for(2200ms);
  assert(host.start(&error));
  assert(waitUntil([&] { return callbackCount.load(std::memory_order_acquire) > 0; }, 2s));
  assert(!failed.load(std::memory_order_acquire));
  host.close();
}

void testOutputReadyStopsAfterFirstRejection(const std::wstring& helperPath) {
  setMode(L"output-ready-false");
  AsioHelperProcess process(helperPath);
  std::string error;
  assert(process.launch(&error));
  Response response;
  assert(requestOpen(&process, &response, &error));
  assert(process.request(Command::CreateBuffers, &response, 2s, &error));
  assert(process.request(Command::Start, &response, 2s, &error));
  auto* shared = process.shared();
  assert(shared);
  assert(waitUntil(
      [&] { return twilight::audio::asio_helper::readAtomic(&shared->callbackHeartbeat) >= 4; },
      2s));
  std::this_thread::sleep_for(25ms);
  assert(twilight::audio::asio_helper::readAtomic(&shared->hostEventWriteSequence) == 0);
  assert(process.request(Command::Stop, &response, 2s, &error));
  assert(process.request(Command::Close, &response, 2s, &error));
  process.shutdown();
}

std::wstring quoteArgument(const std::wstring& value) {
  std::wstring quoted = L"\"";
  quoted += value;
  quoted += L"\"";
  return quoted;
}

void testParentDeathKillsHelper(
    const std::wstring& helperPath,
    const std::wstring& parentFixturePath) {
  std::array<wchar_t, MAX_PATH> tempDirectory{};
  assert(GetTempPathW(static_cast<DWORD>(tempDirectory.size()), tempDirectory.data()) > 0);
  std::array<wchar_t, MAX_PATH> tempFile{};
  assert(GetTempFileNameW(tempDirectory.data(), L"teh", 0, tempFile.data()) != 0);
  DeleteFileW(tempFile.data());

  std::wstring command = quoteArgument(parentFixturePath) + L" " + quoteArgument(helperPath) +
      L" " + quoteArgument(tempFile.data());
  std::vector<wchar_t> commandBuffer(command.begin(), command.end());
  commandBuffer.push_back(L'\0');
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION parent{};
  assert(CreateProcessW(
      parentFixturePath.c_str(),
      commandBuffer.data(),
      nullptr,
      nullptr,
      FALSE,
      CREATE_NO_WINDOW,
      nullptr,
      nullptr,
      &startup,
      &parent));
  CloseHandle(parent.hThread);

  DWORD childPid = 0;
  const std::filesystem::path pidPath(tempFile.data());
  const bool pidReady = waitUntil(
      [&] {
        std::ifstream input(pidPath);
        input >> childPid;
        return childPid != 0;
      },
      3s);
  if (!pidReady) {
    TerminateProcess(parent.hProcess, 93);
    WaitForSingleObject(parent.hProcess, 2000);
  }
  assert(pidReady);
  HANDLE child = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, childPid);
  assert(child);
  assert(TerminateProcess(parent.hProcess, 94));
  assert(WaitForSingleObject(parent.hProcess, 2000) == WAIT_OBJECT_0);
  assert(WaitForSingleObject(child, 3000) == WAIT_OBJECT_0);
  CloseHandle(child);
  CloseHandle(parent.hProcess);
  DeleteFileW(tempFile.data());
}

void testProtocolReasonCodes() {
  auto format = openConfig().format;
  format.dopEncoded = true;
  assert(twilight::audio::asio_helper::decodeAudioFormat(
      twilight::audio::asio_helper::encodeAudioFormat(format)).dopEncoded);
  using twilight::audio::asio_helper::failureReasonCode;
  assert(std::string(failureReasonCode(FailureReason::LaunchFailed)) ==
         "asio_helper_launch_failed");
  assert(std::string(failureReasonCode(FailureReason::ProtocolError)) ==
         "asio_helper_protocol_error");
  assert(std::string(failureReasonCode(FailureReason::ControlTimeout)) ==
         "asio_helper_control_timeout");
  assert(std::string(failureReasonCode(FailureReason::ProcessExited)) ==
         "asio_helper_process_exited");
  assert(std::string(failureReasonCode(FailureReason::CallbackStalled)) ==
         "asio_helper_callback_stalled");
  assert(std::string(failureReasonCode(FailureReason::DeviceRejected)) ==
         "asio_helper_device_rejected");
  assert(std::string(failureReasonCode(FailureReason::FormatRestoreFailed)) ==
         "asio_helper_format_restore_failed");
}

void testPcmBytesReachDriverAcrossReopen(const std::wstring& helperPath) {
  setMode(L"verify-pcm");
  AsioHelperHost host(helperPath);
  for (int rate : {192000, 48000, 192000}) {
    std::string error;
    AsioOpenResult result;
    auto config = openConfig();
    config.format.sampleRate = rate;
    assert(host.open(config, &result, &error));
    std::atomic<int> verified{0};
    std::atomic<bool> corrupted{false};
    assert(host.createBuffers([&](long index) {
      for (long channel = 0; channel < 2; ++channel) {
        auto* samples = static_cast<float*>(host.outputBuffer(channel, index));
        for (size_t frame = 0; frame < 64; ++frame) samples[frame] = channel == 0 ? 0.25f : -0.5f;
      }
      host.commitOutputBuffer(index, 64);
    }, [&](AsioHostEvent, const std::string& message) {
      if (message == "pcm-verified") verified.fetch_add(1);
      else corrupted.store(true);
    }, &error));
    assert(host.start(&error));
    assert(waitUntil([&] { return verified.load() >= 3 || corrupted.load(); }, 2s));
    assert(!corrupted.load() && verified.load() >= 3);
    host.close();
  }
}

void testCatalogIdentity() {
  using namespace twilight::audio;
  using namespace twilight::audio::asio_windows;
  const AsioDriverEntry x64{"asio:{same}", "DAC", "{same}", AsioArchitecture::X64};
  const AsioDriverEntry x86{"asio:x86:{same}", "DAC", "{same}", AsioArchitecture::X86};
  const AsioDriverEntry other{"asio:x86:{other}", "DAC", "{other}", AsioArchitecture::X86};
  assert(AsioDriverCatalog::resolveEntries({x86, x64}, "auto")->id == x64.id);
  assert(AsioDriverCatalog::resolveEntries({x86}, "auto")->id == x86.id);
  assert(AsioDriverCatalog::resolveEntries({x86, x64}, "asio:DAC")->id == x64.id);
  assert(AsioDriverCatalog::resolveEntries({x86}, "asio:DAC")->id == x86.id);
  assert(!AsioDriverCatalog::resolveEntries({x86, other}, "asio:DAC"));
  assert(!AsioDriverCatalog::resolveEntries({x64}, x86.id));
  assert(!AsioDriverCatalog::resolveEntries({x86}, x64.id));
  assert(AsioDriverCatalog::resolveEntries({x86, x64}, x86.id)->architecture == AsioArchitecture::X86);
  AsioDeviceInfo info;
  info.id = x64.id;
  info.nativeDsdCapable = true;
  DeviceCapabilityCache::instance().put(info);
  info.id = x86.id;
  info.nativeDsdCapable = false;
  DeviceCapabilityCache::instance().put(info);
  assert(DeviceCapabilityCache::instance().get(x64.id)->nativeDsdCapable);
  assert(!DeviceCapabilityCache::instance().get(x86.id)->nativeDsdCapable);
}

void testLargeNativeDsdBuffers(const std::wstring& helperPath) {
  setMode(L"large-dsd-bits");
  AsioHelperHost host(helperPath);
  for (int preferred : {1024, 2048}) {
    auto config = openConfig();
    config.bufferSizeFrames = preferred;
    config.bufferSizeInPcmFrames = true;
    config.format.sampleRate = 11289600;
    config.format.sampleFormat = twilight::audio::AudioSampleFormat::DsdInt8Msb1;
    config.format.bitDepth = 1;
    AsioOpenResult result;
    std::string error;
    assert(host.open(config, &result, &error));
    std::atomic<int> verified{0};
    std::atomic<bool> failed{false};
    assert(host.createBuffers([&](long index) {
      const auto frames = host.activeRenderFrameCapacity();
      assert(frames == static_cast<size_t>(preferred * 32));
      for (long channel = 0; channel < 2; ++channel)
        std::memset(host.outputBuffer(channel, index), channel == 0 ? 0x31 : 0x52, frames);
      host.commitOutputBuffer(index, frames);
    }, [&](AsioHostEvent, const std::string& message) {
      if (message == "large-dsd-verified") verified.fetch_add(1);
      else { std::cerr << "Large DSD fixture: " << message << '\n'; failed.store(true); }
    }, &error));
    assert(host.activeBufferSize() == preferred * 256);
    assert(host.start(&error));
    assert(waitUntil([&] {
      return failed.load() || (verified.load() >= 5 && host.renderHealth().callbackCount >= 5 &&
                              host.dsdBufferUnitConfirmed());
    }, 3s));
    assert(!failed.load());
    assert(host.dsdBufferUnitConfirmed());
    host.close();
    assert(host.lastCloseError().empty());
  }
}

void testOversizeDsdWireBuffersFail(const std::wstring& helperPath) {
  for (const auto* mode : {L"large-dsd-ner8", L"large-dsd-bytes"}) {
    setMode(mode);
    AsioHelperHost host(helperPath);
    auto config = openConfig();
    config.bufferSizeFrames = 2048;
    config.bufferSizeInPcmFrames = true;
    config.format.sampleRate = 11289600;
    config.format.sampleFormat = twilight::audio::AudioSampleFormat::DsdInt8Msb1;
    config.format.bitDepth = 1;
    AsioOpenResult result;
    std::string error;
    assert(host.open(config, &result, &error));
    std::atomic<bool> failed{false};
    const bool created = host.createBuffers([](long) {}, [&](AsioHostEvent event, const std::string& message) {
      if (event == AsioHostEvent::HelperFailure && message.find("byte capacity") != std::string::npos)
        failed.store(true);
    }, &error);
    if (std::wstring_view(mode) == L"large-dsd-ner8") {
      assert(!created && error.find("byte capacity") != std::string::npos);
    } else {
      assert(created && host.start(&error));
      assert(waitUntil([&] { return failed.load(); }, 3s));
    }
    host.close();
  }
}

void testHandshakeMismatch(const std::wstring& helperPath) {
  setMode(L"normal");
  DWORD binaryType = 0;
  assert(GetBinaryTypeW(helperPath.c_str(), &binaryType));
  const auto wrongArchitecture = binaryType == SCS_64BIT_BINARY
      ? twilight::audio::AsioArchitecture::X86 : twilight::audio::AsioArchitecture::X64;
  AsioHelperProcess wrongBitness(helperPath, wrongArchitecture);
  std::string error;
  assert(!wrongBitness.launch(&error));
  if (!error.starts_with("asio_helper_protocol_error")) std::cerr << "Architecture handshake: " << error << '\n';
  assert(error.starts_with("asio_helper_protocol_error"));
  assert(!wrongBitness.alive());
  setMode(L"protocol-mismatch");
  AsioHelperProcess wrongVersion(helperPath);
  assert(!wrongVersion.launch(&error));
  if (!error.starts_with("asio_helper_protocol_error")) std::cerr << "Version handshake: " << error << '\n';
  assert(error.starts_with("asio_helper_protocol_error"));
  assert(!wrongVersion.alive());
}

void testArchitectureRouting(const std::wstring& x64Path, const std::wstring& x86Path) {
  using namespace twilight::audio;
  using namespace twilight::audio::asio_windows;
  setMode(L"routing");
  const auto catalog = [] { return std::vector<AsioDriverEntry>{
      {"asio:{fixture}", "Twilight ASIO fixture", "{fixture}", AsioArchitecture::X64},
      {"asio:x86:{fixture}", "Twilight ASIO fixture", "{fixture}", AsioArchitecture::X86}}; };
  AsioHelperHost host(x64Path, x86Path, catalog);
  assert(host.enumerateDevices().size() == 2);
  assert(host.diagnostics().helperArchitecture.empty());  // Enumeration never starts a helper.
  for (const auto* architecture : {"x86", "x64", "x86"}) {
    const auto id = std::string(architecture) == "x86" ? "asio:x86:{fixture}" : "asio:{fixture}";
    std::string error;
    AsioDeviceInfo probed;
    assert(host.probeDevice(id, &probed, &error));
    assert(probed.id == id && probed.driverArchitecture == architecture);
    auto config = openConfig();
    config.deviceId = id;
    AsioOpenResult result;
    assert(host.open(config, &result, &error));
    assert(host.diagnostics().helperArchitecture == architecture);
    host.close();
    assert(host.lastCloseError().empty());
  }
  AsioHelperHost missing(x64Path, L"missing-asio-x86-fixture.exe", catalog);
  assert(missing.enumerateDevices().size() == 2);
  auto config = openConfig();
  config.deviceId = "asio:x86:{fixture}";
  std::string error;
  AsioOpenResult result;
  assert(!missing.open(config, &result, &error));
  assert(error.starts_with("asio_helper_launch_failed"));
  config.deviceId = "asio:{fixture}";
  assert(missing.open(config, &result, &error));
  missing.close();
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  assert(argc == 3 || argc == 4);
  testCatalogIdentity();
  testHandshakeMismatch(argv[1]);
  if (argc == 4) testArchitectureRouting(argv[3], argv[1]);
  testProtocolReasonCodes();
  testNormalRoundTrip(argv[1]);
  testNativeDsdQueuePreservesOrderWithoutParentWakeups(argv[1]);
  testLargeNativeDsdBuffers(argv[1]);
  testOversizeDsdWireBuffersFail(argv[1]);
  testPcmBytesReachDriverAcrossReopen(argv[1]);
  testWireCapacityAndFloat64(argv[1]);
  testControlTimeout(argv[1]);
  testAbnormalExit(argv[1]);
  testExternalKill(argv[1]);
  testDeviceReject(argv[1]);
  testFormatRestoreFailure(argv[1]);
  testOpenRestoreFailurePoisonsTheHelper(argv[1]);
  testMalformedOpenFailsClosed(argv[1]);
  testCallbackWatchdog(argv[1]);
  testStopTimeoutRemainsObservable(argv[1]);
  testCallbackBacklogDoesNotOverwritePendingGeneration(argv[1]);
  testDelayedStartResetsCallbackWatchdog(argv[1]);
  testOutputReadyStopsAfterFirstRejection(argv[1]);
  testParentDeathKillsHelper(argv[1], argv[2]);
  SetEnvironmentVariableW(L"TAE_ASIO_HELPER_FIXTURE_MODE", nullptr);
  return 0;
}
