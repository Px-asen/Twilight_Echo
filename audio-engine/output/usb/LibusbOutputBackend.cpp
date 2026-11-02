#include "LibusbOutputBackend.h"
#include "UsbPacketScheduler.h"
#include "UsbPcmRender.h"
#include "UsbDsdRender.h"
#include "UsbImplicitFeedback.h"
#include "../../core/DiagnosticLog.h"
#include "../../utils/JsonUtils.h"

#include <libusb.h>
#include <array>
#include <atomic>
#include <chrono>
#include <fcntl.h>
#include <future>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <unistd.h>

namespace twilight::audio {
namespace {

void usbCheck(int result, const char* action) {
  if (result < 0) throw std::runtime_error(std::string(action) + ": " + libusb_error_name(result));
}

int integer(const std::string& json, const char* field) {
  const auto value = json_utils::fieldNumber(json, field);
  if (!value || *value < 0 || *value > INT32_MAX || std::floor(*value) != *value)
    throw std::runtime_error(std::string("USB Host 字段无效：") + field);
  return static_cast<int>(*value);
}

AudioSampleFormat wireFormat(const std::string& name) {
  if (name == "int16") return AudioSampleFormat::Int16Interleaved;
  if (name == "int24") return AudioSampleFormat::Int24Interleaved;
  if (name == "int24-in32") return AudioSampleFormat::Int24In32Interleaved;
  if (name == "int32") return AudioSampleFormat::Int32Interleaved;
  if (name == "float32") return AudioSampleFormat::Float32Interleaved;
  throw std::runtime_error("USB Host 返回不支持的 PCM 容器：" + name);
}

struct ConfigDeleter { void operator()(libusb_config_descriptor* p) const { libusb_free_config_descriptor(p); } };

}  // namespace

struct LibusbOutputBackend::Impl {
  struct Claim { int number; bool detached = false; bool claimed = false; };
  struct Slot {
    Impl* owner = nullptr;
    libusb_transfer* transfer = nullptr;
    bool feedback = false;
    bool submitted = false; // Event-thread owned after start's allocation phase.
    std::vector<uint8_t> bytes;
    std::vector<float> scratch;
    std::vector<uint8_t> dsdScratch;
    ~Slot() { if (transfer) libusb_free_transfer(transfer); }
  };

  std::shared_ptr<UsbDirectHost> host;
  OutputConfig config;
  libusb_context* context = nullptr;
  libusb_device_handle* handle = nullptr;
  int fd = -1;
  bool leased = false;
  std::vector<Claim> claims;
  int streamInterface = -1;
  int profileIndex = -1;
  bool endpointRateControl = false;
  uint8_t endpoint = 0;
  uint8_t feedbackEndpoint = 0;
  int feedbackInterface = -1;
  int feedbackAlternate = 0;
  bool implicitFeedback = false;
  size_t feedbackBytes = 0;
  UsbImplicitFeedback implicitPackets;
  std::chrono::steady_clock::time_point lastImplicitPacket;
  UsbPacketScheduler scheduler;
  AudioFormat format;
  int wireSampleRate = 0;
  size_t byteFramesPerWireFrame = 1;
  size_t wireStride = 0;
  bool littleEndianDsdWords = false;
  uint64_t dopMarkerIndex = 0;
  std::atomic<bool> transportCompleted{false};
  AudioFormat publishedFormat;
  mutable std::mutex infoMutex;
  OutputInfo info;
  TypedRenderCallback typed;
  RenderCallback floats;
  OutputEventCallback event;
  std::vector<std::unique_ptr<Slot>> slots;
  std::thread worker;
  std::atomic<bool> stopRequested{false};
  size_t inFlight = 0;
  bool cancelling = false;
  bool startupComplete = false;
  std::string failure;
  OutputBackendEvent failureEvent = OutputBackendEvent::RenderError;
  static constexpr int kPackets = UsbImplicitFeedback::kPackets;

  int transferCount() const {
    const double frames = wireSampleRate * byteFramesPerWireFrame * scheduler.intervalSeconds() * kPackets;
    return config.preferredBufferSize > 0
        ? std::clamp(static_cast<int>(std::ceil(config.preferredBufferSize / frames)), 2, 16) : 4;
  }

  void describeBuffers() { // infoMutex held, including before the pipeline allocates render scratch.
    const int count = transferCount();
    const int queuedPackets = (implicitFeedback ? 2 : count) * kPackets;
    info.bufferSizeFrames = static_cast<int>(count * scheduler.maxFrames() * kPackets * byteFramesPerWireFrame);
    info.latencyFrames = static_cast<int>(std::ceil(queuedPackets * scheduler.intervalSeconds() * wireSampleRate * byteFramesPerWireFrame));
    info.latencyMs = queuedPackets * scheduler.intervalSeconds() * 1000;
    info.latencyInfo.bufferLatencyMs = info.latencyInfo.totalLatencyMs = info.latencyMs;
  }

  void claim(int number) {
    claims.push_back({number});
    auto& entry = claims.back();
    const int active = libusb_kernel_driver_active(handle, number);
    usbCheck(active, "无法查询 USB 内核驱动");
    if (active == 1) {
      usbCheck(libusb_detach_kernel_driver(handle, number), "无法释放 USB 系统音频接口");
      entry.detached = true;
    }
    usbCheck(libusb_claim_interface(handle, number), "无法独占 USB 接口");
    entry.claimed = true;
  }

  void noteCleanup(int result, const char* action) {
    if (result < 0 && result != LIBUSB_ERROR_NO_DEVICE)
      DiagnosticLog::instance().append(DiagLevel::Error, "usb_direct_release", std::string(action) + ": " + libusb_error_name(result));
  }

  void releaseProfile() {
    const auto idle = [this] {
      if (implicitFeedback && feedbackInterface >= 0 && std::any_of(claims.begin(), claims.end(), [this](const Claim& c) {
          return c.number == feedbackInterface && c.claimed;
        })) noteCleanup(libusb_set_interface_alt_setting(handle, feedbackInterface, 0), "无法关闭 USB 隐式反馈接口");
      if (streamInterface >= 0 && std::any_of(claims.begin(), claims.end(), [this](const Claim& c) {
          return c.number == streamInterface && c.claimed;
        })) noteCleanup(libusb_set_interface_alt_setting(handle, streamInterface, 0), "无法关闭 USB 备用接口");
    };
    // UAC1 endpoint controls require the active alternate. UAC2 restores its
    // source clock only after the streaming interface has become idle.
    if (!endpointRateControl) idle();
    if (profileIndex >= 0) {
      const auto error = host->restore();
      if (!error.empty()) DiagnosticLog::instance().append(DiagLevel::Error, "usb_direct_restore", error);
    }
    if (endpointRateControl) idle();
    for (auto it = claims.rbegin(); it != claims.rend(); ++it) {
      if (it->claimed) noteCleanup(libusb_release_interface(handle, it->number), "无法释放 USB 接口");
    }
    for (auto it = claims.rbegin(); it != claims.rend(); ++it) {
      if (it->detached) noteCleanup(libusb_attach_kernel_driver(handle, it->number), "无法恢复 USB 系统驱动");
    }
    claims.clear();
    streamInterface = -1;
    profileIndex = -1;
    feedbackInterface = -1;
    implicitFeedback = false;
  }

  void openProfile(const std::string& profile, const AudioFormat& requested) {
    const int control = integer(profile, "control");
    streamInterface = integer(profile, "interface");
    profileIndex = integer(profile, "index");
    endpointRateControl = integer(profile, "uac") == 1;
    const int alternate = integer(profile, "alternate");
    endpoint = static_cast<uint8_t>(integer(profile, "endpoint"));
    feedbackEndpoint = static_cast<uint8_t>(integer(profile, "feedback"));
    const auto implicit = json_utils::fieldObject(profile, "implicitFeedback");
    implicitFeedback = !implicit.empty();
    size_t feedbackStride = 0;
    if (implicitFeedback) {
      feedbackInterface = integer(implicit, "interface");
      feedbackAlternate = integer(implicit, "alternate");
      feedbackEndpoint = static_cast<uint8_t>(integer(implicit, "endpoint"));
      feedbackStride = static_cast<size_t>(integer(implicit, "frameBytes"));
      if (feedbackInterface == streamInterface || feedbackInterface == control || feedbackAlternate < 1 || feedbackStride == 0)
        throw std::runtime_error("USB 隐式反馈源接口或帧大小无效");
    }
    const auto packing = json_utils::fieldString(profile, "format").value_or("");
    const bool nativeDsd = packing == "dsd-u32-be" || packing == "dsd-u32-le";
    // PCM hosts predating the DSD profile extension omit clockDivisor.
    const int divisor = json_utils::fieldNumber(profile, "clockDivisor") ? integer(profile, "clockDivisor") : 1;
    if (nativeDsd != isDsdSampleFormat(requested.sampleFormat) || divisor != (nativeDsd ? 32 : 1) ||
        requested.sampleRate <= 0 || requested.sampleRate % divisor != 0)
      throw std::runtime_error("USB DSD 传输字宽与请求位时钟不符");
    format = {requested.sampleRate, integer(profile, "channels"), nativeDsd ? 1 : integer(profile, "bits"),
        nativeDsd ? AudioSampleFormat::DsdInt8Msb1 : wireFormat(packing), requested.dopEncoded};
    if (requested.dopEncoded) {
      format.bitDepth = 24;
      if (!isDopCarrierFormat(format)) throw std::runtime_error("USB 备用接口无法原样承载 DoP");
    }
    wireSampleRate = requested.sampleRate / divisor;
    byteFramesPerWireFrame = nativeDsd ? 4 : 1;
    wireStride = audioFormatBytesPerFrame(format) * byteFramesPerWireFrame;
    littleEndianDsdWords = packing == "dsd-u32-le";
    if (format.channelCount < 1 || format.channelCount > 2 || alternate < 1 || streamInterface == control)
      throw std::runtime_error("USB 音频备用接口或声道数无效");

    libusb_config_descriptor* rawConfig = nullptr;
    usbCheck(libusb_get_active_config_descriptor(libusb_get_device(handle), &rawConfig), "无法读取 USB 活动配置");
    std::unique_ptr<libusb_config_descriptor, ConfigDeleter> descriptor(rawConfig);
    const libusb_endpoint_descriptor* data = nullptr;
    const libusb_endpoint_descriptor* feedback = nullptr;
    for (uint8_t i = 0; i < descriptor->bNumInterfaces; ++i) {
      const auto& interface = descriptor->interface[i];
      for (int a = 0; a < interface.num_altsetting; ++a) {
        const auto& setting = interface.altsetting[a];
        for (uint8_t e = 0; e < setting.bNumEndpoints; ++e) {
          const auto& ep = setting.endpoint[e];
          if (setting.bInterfaceNumber == streamInterface && setting.bAlternateSetting == alternate && ep.bEndpointAddress == endpoint) data = &ep;
          if (setting.bInterfaceNumber == (implicitFeedback ? feedbackInterface : streamInterface) &&
              setting.bAlternateSetting == (implicitFeedback ? feedbackAlternate : alternate) &&
              feedbackEndpoint != 0 && ep.bEndpointAddress == feedbackEndpoint) feedback = &ep;
        }
      }
    }
    if (!data || (data->bmAttributes & 3) != LIBUSB_TRANSFER_TYPE_ISOCHRONOUS || (endpoint & 0x80))
      throw std::runtime_error("USB 活动配置缺少所选等时 OUT 端点");
    const int sync = (data->bmAttributes >> 2) & 3;
    if (sync == 0 || ((sync == 1 || implicitFeedback) && !feedback))
      throw std::runtime_error("USB 异步输出缺少已匹配的反馈端点");
    if (feedback && ((feedback->bmAttributes & 3) != LIBUSB_TRANSFER_TYPE_ISOCHRONOUS || !(feedbackEndpoint & 0x80)))
      throw std::runtime_error("USB 反馈端点不是等时 IN");
    const int speed = libusb_get_device_speed(libusb_get_device(handle));
    const auto geometryFor = [&](const libusb_endpoint_descriptor* ep) {
      UsbIsoGeometry geometry;
      geometry.rawMaxPacketSize = ep->wMaxPacketSize;
      geometry.interval = ep->bInterval;
      if (speed == LIBUSB_SPEED_FULL) geometry.speed = UsbBusSpeed::Full;
      else if (speed == LIBUSB_SPEED_HIGH) geometry.speed = UsbBusSpeed::High;
      else if (speed >= LIBUSB_SPEED_SUPER) {
        geometry.speed = UsbBusSpeed::Super;
        libusb_ss_endpoint_companion_descriptor* companion = nullptr;
        usbCheck(libusb_get_ss_endpoint_companion_descriptor(context, ep, &companion), "无法读取 USB SuperSpeed 端点容量");
        geometry.superSpeedBytesPerInterval = companion->wBytesPerInterval;
        libusb_free_ss_endpoint_companion_descriptor(companion);
      } else throw std::runtime_error("无法确定 USB 实际总线速度");
      return geometry;
    };
    std::string geometryError;
    if (!scheduler.configure(geometryFor(data), wireSampleRate, wireStride, &geometryError))
      throw std::runtime_error(geometryError);
    if (implicitFeedback) {
      if (sync != 1 || feedback->bInterval != data->bInterval || ((feedback->bmAttributes >> 2) & 3) != 1 ||
          !(((feedback->bmAttributes >> 4) & 3) == 2 || (endpointRateControl && data->bSynchAddress == feedbackEndpoint)))
        throw std::runtime_error("USB 隐式反馈源的同步类型、服务间隔或端点关联不匹配");
      UsbPacketScheduler source;
      if (!source.configure(geometryFor(feedback), wireSampleRate, feedbackStride, &geometryError))
        throw std::runtime_error(geometryError);
      feedbackBytes = source.maxPacketBytes();
      implicitPackets.configure(feedbackStride, scheduler.maxFrames(), static_cast<size_t>(transferCount() + 2));
    } else {
      feedbackBytes = feedback ? feedback->wMaxPacketSize & 0x7ff : 0;
      if (feedback && (feedbackBytes < 3 || feedbackBytes > 4)) throw std::runtime_error("USB 反馈包容器不是 3／4 字节");
    }

    claim(control);
    claim(streamInterface);
    if (implicitFeedback) claim(feedbackInterface);
    usbCheck(libusb_set_interface_alt_setting(handle, streamInterface, 0), "无法选择 USB 空闲接口");
    if (implicitFeedback)
      usbCheck(libusb_set_interface_alt_setting(handle, feedbackInterface, 0), "无法选择 USB 反馈空闲接口");
    if (endpointRateControl) {
      usbCheck(libusb_set_interface_alt_setting(handle, streamInterface, alternate), "无法选择 USB 播放备用接口");
      if (implicitFeedback)
        usbCheck(libusb_set_interface_alt_setting(handle, feedbackInterface, feedbackAlternate), "无法选择 USB 隐式反馈备用接口");
    }
    const auto configured = host->configure(profileIndex, requested.sampleRate);
    if (!configured.empty()) throw std::runtime_error(configured);
    if (!endpointRateControl) {
      if (implicitFeedback)
        usbCheck(libusb_set_interface_alt_setting(handle, feedbackInterface, feedbackAlternate), "无法选择 USB 隐式反馈备用接口");
      usbCheck(libusb_set_interface_alt_setting(handle, streamInterface, alternate), "无法选择 USB 播放备用接口");
    }
  }

  void fault(const std::string& message, OutputBackendEvent reason = OutputBackendEvent::RenderError) {
    if (failure.empty()) { failure = message; failureEvent = reason; }
    stopRequested.store(true, std::memory_order_release);
  }

  bool fill(Slot& slot) {
    if (slot.feedback) {
      slot.transfer->length = static_cast<int>(feedbackBytes * slot.transfer->num_iso_packets);
      for (int i = 0; i < slot.transfer->num_iso_packets; ++i)
        slot.transfer->iso_packet_desc[i].length = static_cast<unsigned>(feedbackBytes);
      return true;
    }
    UsbImplicitFeedback::Frames measured{};
    if (implicitFeedback && !implicitPackets.pop(measured)) return false;
    size_t totalFrames = 0;
    for (int i = 0; i < kPackets; ++i) {
      const size_t frames = implicitFeedback ? measured[i] : scheduler.nextFrames();
      slot.transfer->iso_packet_desc[i].length = static_cast<unsigned>(frames * wireStride);
      totalFrames += frames;
    }
    slot.transfer->length = static_cast<int>(totalFrames * wireStride);
    if (isDsdSampleFormat(format.sampleFormat))
      renderUsbNativeDsd(slot.bytes.data(), totalFrames, format, littleEndianDsdWords, typed, slot.dsdScratch);
    else if (format.dopEncoded)
      renderUsbDop(slot.bytes.data(), totalFrames, format, typed, dopMarkerIndex);
    else renderUsbPcm(slot.bytes.data(), totalFrames, format, typed, floats, slot.scratch);
    return true;
  }

  void submit(Slot& slot) {
    if (stopRequested.load(std::memory_order_acquire)) return;
    if (!fill(slot)) return; // Implicit OUT slots wait for a measured IN packet layout.
    const int result = libusb_submit_transfer(slot.transfer);
    if (result < 0) fault(std::string("USB 等时提交失败：") + libusb_error_name(result),
        result == LIBUSB_ERROR_NO_DEVICE ? OutputBackendEvent::DeviceInvalidated : OutputBackendEvent::RenderError);
    else { slot.submitted = true; ++inFlight; }
  }

  static void LIBUSB_CALL completed(libusb_transfer* transfer) {
    auto& slot = *static_cast<Slot*>(transfer->user_data);
    auto& self = *slot.owner;
    slot.submitted = false;
    --self.inFlight;
    if (self.stopRequested.load(std::memory_order_acquire)) return;
    if (transfer->status != LIBUSB_TRANSFER_COMPLETED) {
      self.fault("USB 等时传输失败，状态 " + std::to_string(transfer->status),
          transfer->status == LIBUSB_TRANSFER_NO_DEVICE ? OutputBackendEvent::DeviceInvalidated : OutputBackendEvent::RenderError);
      return;
    }
    for (int i = 0; i < transfer->num_iso_packets; ++i) {
      const auto& packet = transfer->iso_packet_desc[i];
      if (packet.status != LIBUSB_TRANSFER_COMPLETED || (!slot.feedback && packet.actual_length != packet.length)) {
        self.fault("USB 等时包未完整传输，状态 " + std::to_string(packet.status),
            packet.status == LIBUSB_TRANSFER_NO_DEVICE ? OutputBackendEvent::DeviceInvalidated : OutputBackendEvent::RenderError);
        return;
      }
    }
    if (slot.feedback) {
      std::string error;
      bool accepted;
      if (self.implicitFeedback) {
        std::array<size_t, kPackets> lengths{};
        for (size_t i = 0; i < lengths.size(); ++i) lengths[i] = transfer->iso_packet_desc[i].actual_length;
        accepted = self.implicitPackets.push(lengths, &error);
        if (accepted && std::any_of(lengths.begin(), lengths.end(), [](size_t length) { return length != 0; }))
          self.lastImplicitPacket = std::chrono::steady_clock::now();
      } else accepted = self.scheduler.applyFeedback(std::span(slot.bytes.data(), transfer->iso_packet_desc[0].actual_length), &error);
      if (!accepted) {
        self.fault(error);
        return;
      }
      if (self.implicitFeedback) for (auto& output : self.slots)
        if (!output->feedback && !output->submitted) self.submit(*output);
    } else self.transportCompleted.store(true, std::memory_order_release);
    self.submit(slot);
  }

  void run(std::promise<std::string> started) {
    lastImplicitPacket = std::chrono::steady_clock::now();
    for (auto& slot : slots) if (!implicitFeedback || slot->feedback) submit(*slot);
    startupComplete = failure.empty();
    started.set_value(failure);
    while (inFlight != 0) {
      if (implicitFeedback && std::chrono::steady_clock::now() - lastImplicitPacket >= std::chrono::seconds(1))
        fault("USB 隐式反馈源连续一秒未提供音频帧，无法继续同步输出");
      if (stopRequested.load(std::memory_order_acquire) && !cancelling) {
        cancelling = true;
        for (auto& slot : slots) if (slot->submitted) libusb_cancel_transfer(slot->transfer);
      }
      timeval wait{0, 100000};
      const int result = libusb_handle_events_timeout_completed(context, &wait, nullptr);
      if (result < 0 && result != LIBUSB_ERROR_INTERRUPTED)
        fault(std::string("USB 事件循环失败：") + libusb_error_name(result));
    }
    if (startupComplete && !failure.empty() && event) event(failureEvent, failure);
  }

  void stop() {
    stopRequested.store(true, std::memory_order_release);
    if (context) libusb_interrupt_event_handler(context);
    if (worker.joinable()) worker.join();
    slots.clear(); // Every submitted transfer has completed or delivered cancellation.
    implicitPackets.reset();
    typed = {}; floats = {}; event = {};
  }

  void close() {
    stop();
    if (handle) { releaseProfile(); libusb_close(handle); handle = nullptr; }
    if (context) { libusb_exit(context); context = nullptr; }
    if (fd >= 0) { ::close(fd); fd = -1; }
    if (leased) { host->release(); leased = false; }
    std::lock_guard lock(infoMutex);
    info = {};
    publishedFormat = {};
    transportCompleted.store(false, std::memory_order_release);
  }
};

LibusbOutputBackend::LibusbOutputBackend() : impl_(std::make_unique<Impl>()) {}
LibusbOutputBackend::~LibusbOutputBackend() { close(); }
void LibusbOutputBackend::setUsbDirectHost(std::shared_ptr<UsbDirectHost> host) { impl_->host = std::move(host); }

bool LibusbOutputBackend::setOutputConfig(const OutputConfig& config, std::string* error) {
  if (config.usbPcmPassthrough) {
    if (error) *error = "USB 直连与 Android 系统原样 PCM 是两种输出方式，请关闭系统原样 PCM";
    return false;
  }
  impl_->config = config;
  return true;
}

bool LibusbOutputBackend::open(const std::string& device, const AudioFormat& requested, std::string* error) {
  close();
  if (!impl_->host) { if (error) *error = "USB 直连未安装 Android Host"; return false; }
  try {
    const auto lease = impl_->host->acquire(device, requested);
    const auto hostError = json_utils::fieldString(lease, "error");
    if (hostError) throw std::runtime_error(*hostError);
    impl_->leased = true;
    const int borrowed = integer(lease, "fd");
    impl_->fd = fcntl(borrowed, F_DUPFD_CLOEXEC, 0);
    if (impl_->fd < 0) throw std::runtime_error("无法复制已授权的 USB fd");
    const libusb_init_option option{LIBUSB_OPTION_NO_DEVICE_DISCOVERY, {.ival = 1}};
    usbCheck(libusb_init_context(&impl_->context, &option, 1), "无法初始化 libusb");
    usbCheck(libusb_wrap_sys_device(impl_->context, impl_->fd, &impl_->handle), "无法接入已授权 USB 连接");
    std::string lastError = "USB 设备没有匹配请求的音频备用接口";
    bool opened = false;
    for (const auto& profile : json_utils::splitTopLevelObjects(json_utils::fieldArray(lease, "profiles"))) {
      try {
        impl_->openProfile(profile, requested);
        opened = true;
        break;
      } catch (const std::exception& failure) {
        lastError = failure.what();
        impl_->releaseProfile();
      }
    }
    if (!opened) throw std::runtime_error(lastError);
    std::lock_guard lock(impl_->infoMutex);
    impl_->publishedFormat = impl_->format;
    auto& info = impl_->info;
    info.backend = info.actualBackend = id();
    info.providerImplementation = "libusb-1.0.29";
    info.devicePathKind = "usb-direct";
    info.deviceName = info.actualDeviceName = json_utils::fieldString(lease, "name").value_or(device);
    info.actualDeviceId = device;
    info.driverName = info.actualDriverName = "libusb 1.0.29";
    info.exclusive = true;
    info.accessMode = "exclusive";
    info.perfectReasonCode = "backend_not_output_perfect";
    info.perfectReason = "USB 直连独占；数字采样保持待验收";
    info.requestedSampleRate = requested.sampleRate;
    info.requestedSampleFormat = sampleFormatToString(requested.sampleFormat);
    info.outputSampleRate = info.actualSampleRate = impl_->format.sampleRate;
    info.outputBitDepth = info.actualBitDepth = impl_->format.bitDepth;
    info.outputChannels = info.actualChannels = impl_->format.channelCount;
    info.outputSampleFormat = info.actualOutputFormat = sampleFormatToString(impl_->format.sampleFormat);
    info.diagnostics.transportSampleRate = impl_->wireSampleRate;
    info.diagnostics.semanticSampleRate = requested.sampleRate;
    impl_->describeBuffers();
    info.capabilityReason = impl_->implicitFeedback
        ? "USB 接口已独占，按 IN 音频包帧数进行隐式反馈；物理数字输出尚待验收"
        : "USB 接口已独占，播放格式与采样率已确认；物理数字输出尚待验收";
    return true;
  } catch (const std::exception& failure) {
    if (error) *error = failure.what();
    close();
    return false;
  }
}

bool LibusbOutputBackend::start(RenderCallback callback, OutputEventCallback event, std::string* error) {
  return startTyped({}, std::move(callback), std::move(event), error);
}

bool LibusbOutputBackend::startTyped(TypedRenderCallback typed, RenderCallback floats, OutputEventCallback event, std::string* error) {
  auto& self = *impl_;
  if (!self.handle || self.worker.joinable()) { if (error) *error = "USB 输出未打开或仍在运行"; return false; }
  if ((self.format.dopEncoded || isDsdSampleFormat(self.format.sampleFormat)) && !typed) {
    if (error) *error = "USB DoP／Native DSD 需要 typed 回调，不能使用 Float32 回退";
    return false;
  }
  self.typed = std::move(typed); self.floats = std::move(floats); self.event = std::move(event);
  self.stopRequested.store(false, std::memory_order_release);
  self.scheduler.reset();
  self.implicitPackets.reset();
  self.dopMarkerIndex = 0;
  self.transportCompleted.store(false, std::memory_order_release);
  self.failure.clear(); self.inFlight = 0; self.cancelling = false; self.startupComplete = false;
  const int count = self.transferCount();
  for (int i = 0; i < count + (self.feedbackEndpoint ? 2 : 0); ++i) {
    auto slot = std::make_unique<Impl::Slot>();
    slot->owner = &self;
    slot->feedback = i >= count;
    const int packets = slot->feedback && !self.implicitFeedback ? 1 : Impl::kPackets;
    slot->bytes.resize((slot->feedback ? self.feedbackBytes : self.scheduler.maxPacketBytes()) * packets);
    if (!slot->feedback) {
      if (isDsdSampleFormat(self.format.sampleFormat)) slot->dsdScratch.resize(slot->bytes.size());
      else if (!self.format.dopEncoded) slot->scratch.resize(self.scheduler.maxFrames() * packets * self.format.channelCount);
    }
    slot->transfer = libusb_alloc_transfer(packets);
    if (!slot->transfer) { self.stop(); if (error) *error = "无法分配 USB 等时传输"; return false; }
    libusb_fill_iso_transfer(slot->transfer, self.handle, slot->feedback ? self.feedbackEndpoint : self.endpoint,
        slot->bytes.data(), static_cast<int>(slot->bytes.size()), packets, Impl::completed, slot.get(), 1000);
    self.slots.push_back(std::move(slot));
  }
  {
    std::lock_guard lock(self.infoMutex);
    self.describeBuffers();
  }
  std::promise<std::string> started;
  auto ready = started.get_future();
  self.worker = std::thread([&self, promise = std::move(started)]() mutable { self.run(std::move(promise)); });
  const auto failure = ready.get();
  if (!failure.empty()) { self.stop(); if (error) *error = failure; return false; }
  return true;
}

void LibusbOutputBackend::stop() { impl_->stop(); }
void LibusbOutputBackend::close() { impl_->close(); }
AudioFormat LibusbOutputBackend::outputFormat() const { std::lock_guard lock(impl_->infoMutex); return impl_->publishedFormat; }
OutputInfo LibusbOutputBackend::outputInfo() const { std::lock_guard lock(impl_->infoMutex); return impl_->info; }
std::string LibusbOutputBackend::deviceName() const { std::lock_guard lock(impl_->infoMutex); return impl_->info.deviceName; }
DopRuntimeFacts LibusbOutputBackend::dopRuntimeFacts() const {
  std::lock_guard lock(impl_->infoMutex);
  DopRuntimeFacts facts;
  if (!impl_->publishedFormat.dopEncoded) return facts;
  const bool completed = impl_->transportCompleted.load(std::memory_order_acquire);
  facts.state = completed ? DopRuntimeFactState::Proven : DopRuntimeFactState::Candidate;
  facts.candidateFormat = facts.actualFormat = impl_->publishedFormat;
  // USB PCM descriptors do not advertise the receiver's DoP decoder. This is
  // evidence of our exact carrier transport, not a DAC capability assertion.
  facts.explicitlyCapable = false;
  facts.reason = completed ? "USB DoP 载波已完成等时传输；DAC DoP 支持需由用户确认" : "USB DoP 载波已配置，等待首个完整 OUT 传输";
  return facts;
}
NativeDsdRuntimeFacts LibusbOutputBackend::nativeDsdRuntimeFacts() const {
  std::lock_guard lock(impl_->infoMutex);
  if (!isDsdSampleFormat(impl_->publishedFormat.sampleFormat))
    return unsupportedNativeDsdRuntimeFacts("当前没有 USB Native DSD 会话");
  NativeDsdRuntimeFacts facts;
  const bool completed = impl_->transportCompleted.load(std::memory_order_acquire);
  facts.state = completed ? NativeDsdRuntimeFactState::Proven : NativeDsdRuntimeFactState::Candidate;
  facts.requestedDsdRate = facts.actualDsdRate = impl_->publishedFormat.sampleRate;
  facts.channelCount = impl_->publishedFormat.channelCount;
  facts.explicitlyCapable = true;
  facts.advertisedSampleRates = {impl_->publishedFormat.sampleRate};
  facts.reason = completed ? "已识别 USB DSD 备用接口，U32 等时传输已完成；物理输出待验收" : "已识别 USB DSD 备用接口，等待首个完整 OUT 传输";
  return facts;
}

}  // namespace twilight::audio
