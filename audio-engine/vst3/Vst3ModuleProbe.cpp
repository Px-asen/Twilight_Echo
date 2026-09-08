#include "Vst3ModuleProbe.h"
#include "Vst3SharedProtocol.h"

#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/vstspeaker.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/module.h"
#include "public.sdk/source/vst/hosting/plugprovider.h"
#include "public.sdk/source/vst/utility/stringconvert.h"

#include <algorithm>
#include <cmath>
#include <sstream>
#include <utility>

namespace twilight::vst3 {
namespace {

constexpr int32_t kMaximumScannedParameters = static_cast<int32_t>(ipc::kMaxParameters);

struct LayoutProbe {
  const char* name;
  Steinberg::Vst::SpeakerArrangement arrangement;
  int channels;
};

constexpr LayoutProbe kLayoutProbes[] = {
    {"mono", Steinberg::Vst::SpeakerArr::kMono, 1},
    {"stereo", Steinberg::Vst::SpeakerArr::kStereo, 2},
    {"5.1", Steinberg::Vst::SpeakerArr::k51, 6},
    {"7.1", Steinberg::Vst::SpeakerArr::k71Music, 8},
};

bool supportsExactLayout(
    Steinberg::Vst::IComponent& component,
    Steinberg::Vst::IAudioProcessor& processor,
    const LayoutProbe& layout) {
  Steinberg::Vst::SpeakerArrangement input = layout.arrangement;
  Steinberg::Vst::SpeakerArrangement output = layout.arrangement;
  if (processor.setBusArrangements(&input, 1, &output, 1) != Steinberg::kResultTrue) return false;
  Steinberg::Vst::SpeakerArrangement negotiatedInput{};
  Steinberg::Vst::SpeakerArrangement negotiatedOutput{};
  Steinberg::Vst::BusInfo inputBus{};
  Steinberg::Vst::BusInfo outputBus{};
  return processor.getBusArrangement(Steinberg::Vst::kInput, 0, negotiatedInput) == Steinberg::kResultTrue &&
         processor.getBusArrangement(Steinberg::Vst::kOutput, 0, negotiatedOutput) == Steinberg::kResultTrue &&
         negotiatedInput == layout.arrangement && negotiatedOutput == layout.arrangement &&
         component.getBusInfo(Steinberg::Vst::kAudio, Steinberg::Vst::kInput, 0, inputBus) == Steinberg::kResultTrue &&
         component.getBusInfo(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput, 0, outputBus) == Steinberg::kResultTrue &&
         inputBus.busType == Steinberg::Vst::kMain && outputBus.busType == Steinberg::Vst::kMain &&
         inputBus.channelCount == layout.channels && outputBus.channelCount == layout.channels;
}

void populateRuntimeMetadata(
    const VST3::Hosting::PluginFactory& factory,
    const VST3::Hosting::ClassInfo& classInfo,
    AudioEffectDescriptor* descriptor) {
  if (!descriptor) return;
  Steinberg::Vst::PlugProvider provider(factory, classInfo, true);
  if (!provider.initialize()) return;
  const auto component = provider.getComponentPtr();
  const auto controller = provider.getControllerPtr();
  if (!component || component->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kInput) != 1 ||
      component->getBusCount(Steinberg::Vst::kAudio, Steinberg::Vst::kOutput) != 1) {
    return;
  }

  Steinberg::Vst::IAudioProcessor* rawProcessor = nullptr;
  if (component->queryInterface(
          Steinberg::Vst::IAudioProcessor::iid,
          reinterpret_cast<void**>(&rawProcessor)) != Steinberg::kResultTrue ||
      !rawProcessor) {
    return;
  }
  auto processor = Steinberg::owned(rawProcessor);
  if (processor->canProcessSampleSize(Steinberg::Vst::kSample32) == Steinberg::kResultTrue) {
    for (const LayoutProbe& layout : kLayoutProbes) {
      if (supportsExactLayout(*component, *processor, layout)) descriptor->supportedLayouts.emplace_back(layout.name);
    }
  }

  if (!controller) return;
  const Steinberg::int32 count = std::clamp(controller->getParameterCount(), 0, kMaximumScannedParameters);
  descriptor->parameters.reserve(static_cast<size_t>(count));
  for (Steinberg::int32 index = 0; index < count; ++index) {
    Steinberg::Vst::ParameterInfo info{};
    if (controller->getParameterInfo(index, info) != Steinberg::kResultTrue) continue;
    descriptor->parameters.push_back({
        info.id,
        Steinberg::Vst::StringConvert::convert(info.title, 128),
        Steinberg::Vst::StringConvert::convert(info.units, 128),
        std::isfinite(info.defaultNormalizedValue)
            ? std::clamp(info.defaultNormalizedValue, 0.0, 1.0)
            : 0.0,
        info.stepCount,
        info.flags});
  }
}

std::string descriptorJson(const AudioEffectDescriptor& descriptor) {
  std::ostringstream out;
  out << "{\"classId\":\"" << jsonEscape(descriptor.classId) << "\",\"name\":\""
      << jsonEscape(descriptor.name) << "\",\"vendor\":\"" << jsonEscape(descriptor.vendor)
      << "\",\"version\":\"" << jsonEscape(descriptor.version) << "\",\"category\":\""
      << jsonEscape(descriptor.category) << "\",\"supportedLayouts\":[";
  for (size_t index = 0; index < descriptor.supportedLayouts.size(); ++index) {
    if (index > 0) out << ",";
    out << "\"" << jsonEscape(descriptor.supportedLayouts[index]) << "\"";
  }
  out << "],\"parameters\":[";
  for (size_t index = 0; index < descriptor.parameters.size(); ++index) {
    const Vst3ParameterDescriptor& parameter = descriptor.parameters[index];
    if (index > 0) out << ",";
    out << "{\"id\":" << parameter.id << ",\"title\":\"" << jsonEscape(parameter.title)
        << "\",\"unit\":\"" << jsonEscape(parameter.unit) << "\",\"defaultNormalizedValue\":"
        << parameter.defaultNormalizedValue << ",\"stepCount\":" << parameter.stepCount << ",\"flags\":"
        << parameter.flags << "}";
  }
  out << "]}";
  return out.str();
}

}  // namespace

ModuleProbeResult probeModule(const std::string& modulePath) {
  ModuleProbeResult result;
  std::string error;
  const auto module = VST3::Hosting::Module::create(modulePath, error);
  if (!module) {
    result.error = error.empty() ? "VST3 module could not be loaded" : error;
    return result;
  }

  Steinberg::Vst::HostApplication hostApplication;
  module->getFactory().setHostContext(&hostApplication);
  Steinberg::Vst::PluginContextFactory::instance().setPluginContext(&hostApplication);
  Steinberg::Vst::PlugProvider::setErrorStream(nullptr);
  for (const auto& classInfo : module->getFactory().classInfos()) {
    if (classInfo.category() != kVstAudioEffectClass) continue;
    AudioEffectDescriptor descriptor;
    descriptor.classId = classInfo.ID().toString();
    descriptor.name = classInfo.name();
    descriptor.vendor = classInfo.vendor();
    descriptor.version = classInfo.version();
    descriptor.category = classInfo.category();
    populateRuntimeMetadata(module->getFactory(), classInfo, &descriptor);
    result.audioEffects.push_back(std::move(descriptor));
  }
  Steinberg::Vst::PluginContextFactory::instance().setPluginContext(nullptr);

  if (result.audioEffects.empty()) {
    result.error = "The VST3 module does not expose an audio-effect class";
  }
  return result;
}

std::string jsonEscape(const std::string& value) {
  std::ostringstream out;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\':
        out << "\\\\";
        break;
      case '"':
        out << "\\\"";
        break;
      case '\b':
        out << "\\b";
        break;
      case '\f':
        out << "\\f";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (ch < 0x20) {
          constexpr char hex[] = "0123456789ABCDEF";
          out << "\\u00" << hex[(ch >> 4) & 0x0F] << hex[ch & 0x0F];
        } else {
          out << static_cast<char>(ch);
        }
        break;
    }
  }
  return out.str();
}

std::string scannerDescriptorJson(const ModuleProbeResult& result) {
  if (!result.ok()) {
    return "{\"error\":\"" + jsonEscape(result.error) + "\"}";
  }
  std::ostringstream out;
  out << descriptorJson(result.audioEffects.front());
  return out.str();
}

std::string hostInspectionJson(const ModuleProbeResult& result) {
  if (!result.ok()) {
    return "{\"status\":\"error\",\"error\":\"" + jsonEscape(result.error) + "\"}";
  }
  std::ostringstream out;
  out << "{\"status\":\"loaded\",\"audioEffectClassCount\":" << result.audioEffects.size()
      << ",\"firstAudioEffect\":" << descriptorJson(result.audioEffects.front()) << "}";
  return out.str();
}

}  // namespace twilight::vst3
