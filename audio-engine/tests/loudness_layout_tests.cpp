#include "../dsp/DspWorkspaceProcessors.h"
#include "../include/twilight_audio_engine.h"
#include "../utils/JsonUtils.h"
#include "ChannelLayoutFixture.h"

#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <complex>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <numbers>
#include <string>
#include <vector>

using namespace twilight::audio;
namespace {
int checks = 0, failures = 0;
double maxAgreementError = 0, maxReferenceError = 0;

void check(bool value, const std::string& label) {
  ++checks;
  if (!value) { ++failures; std::cerr << "FAIL: " << label << '\n'; }
}

double reference(double weight) {
  const auto z = std::exp(std::complex<double>(0, -2 * std::numbers::pi * 1000 / 48000));
  const auto shelf = (1.53512485958697 - 2.69169618940638 * z + 1.19839281085285 * z * z) /
      (1.0 - 1.69065929318241 * z + 0.73248077421585 * z * z);
  const auto highpass = (1.0 - 2.0 * z + z * z) / (1.0 - 1.99004745483398 * z + 0.99007225036621 * z * z);
  return -0.691 + 10 * std::log10(0.1 * 0.1 * 0.5 * weight * std::norm(shelf * highpass));
}

struct Fixtures {
  std::filesystem::path root = std::filesystem::temp_directory_path() /
      ("twilight-loudness-layout-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::vector<std::filesystem::path> paths;
  Fixtures() { std::filesystem::create_directory(root); }
  ~Fixtures() {
    for (const auto& path : paths) std::filesystem::remove(path);
    std::filesystem::remove(root);
  }
  std::string write(uint32_t mask, unsigned sounding, double lfeAmplitude, std::vector<float>& pcm) {
    constexpr size_t frames = 48000 * 4;
    const int channels = std::popcount(mask);
    auto wave = layout_fixture::wave(mask, frames);
    pcm.resize(frames * channels);
    const size_t start = wave.size() - pcm.size() * 2;
    const int lfe = (mask & 8) ? std::popcount(mask & 7) : -1;
    for (size_t frame = 0; frame < frames; ++frame) {
      for (int channel = 0; channel < channels; ++channel) {
        const double amplitude = channel == lfe && lfeAmplitude > 0
            ? lfeAmplitude : (sounding & (1U << channel)) ? 0.1 : 0;
        const int16_t sample = static_cast<int16_t>(std::lround(
            amplitude * std::sin(2 * std::numbers::pi * 1000 * frame / 48000) * 32767));
        const size_t n = frame * channels + channel;
        pcm[n] = static_cast<float>(sample) / 32768;
        wave[start + n * 2] = static_cast<uint8_t>(sample);
        wave[start + n * 2 + 1] = static_cast<uint8_t>(static_cast<uint16_t>(sample) >> 8);
      }
    }
    auto path = root / (std::to_string(paths.size()) + ".wav");
    paths.push_back(path);
    std::ofstream output(path, std::ios::binary);
    output.write(reinterpret_cast<const char*>(wave.data()), wave.size());
    check(output.good(), "write this loudness fixture");
    return path.generic_string();
  }
};

std::string analyze(TAE_EngineHandle engine, const std::string& path, const std::string& options = "{}") {
  size_t bytes = 0;
  const auto before = TAE_GetAnalysisExecutionCount("loudness");
  check(TAE_AnalyzeLoudness(engine, path.c_str(), options.c_str(), nullptr, 0, &bytes) == TAE_RESULT_OK,
        "C ABI analysis size probe");
  std::vector<char> result(bytes);
  check(TAE_AnalyzeLoudness(engine, path.c_str(), options.c_str(), result.data(), bytes, &bytes) == TAE_RESULT_OK,
        "C ABI analysis buffer read");
  check(TAE_GetAnalysisExecutionCount("loudness") == before + 1, "probe/read decodes only once");
  return std::string(result.data());
}

void verify(TAE_EngineHandle engine, Fixtures& fixtures, const char* name,
            uint32_t mask, unsigned sounding, double weight, double lfeAmplitude = 0) {
  std::vector<float> pcm;
  const std::string path = fixtures.write(mask, sounding, lfeAmplitude, pcm);
  AudioFormat format;
  format.sampleRate = 48000;
  format.channelCount = std::popcount(mask);
  format.channelMask = mask;
  DspConfig config;
  config.enabled = config.meterEnabled = true;
  LoudnessMeterProcessor meter;
  meter.configure(config); meter.prepare(format);
  const auto before = pcm;
  for (size_t frame = 0; frame < 48000 * 4; frame += 4096) {
    meter.process(pcm.data() + frame * format.channelCount, std::min<size_t>(4096, 48000 * 4 - frame));
  }
  check(pcm == before, "realtime metering leaves the offline input PCM unchanged");
  const auto json = analyze(engine, path);
  if (weight == 0) {
    check(json_utils::fieldString(json, "error").value_or("").find("non-silent") != std::string::npos,
          "LFE-only track has no integrated loudness, not a finite normalization gain: " + json);
    check(std::isinf(meter.integratedLufs()) && meter.integratedLufs() < 0,
          "LFE-only realtime loudness is negative infinity");
    check(std::abs(meter.truePeakDb() + 20) < 0.02, "LFE-only true peak still measures its signal");
    return;
  }
  check(!json_utils::fieldString(json, "error").has_value(), std::string(name) + " offline analysis: " + json);
  check(json_utils::fieldNumber(json, "algorithmVersion") == 3, "native measurement reports algorithm 3");
  check(json_utils::fieldNumber(json, "channels") == format.channelCount, "offline decoded channel count");
  check(json_utils::fieldNumber(json, "analyzedFrames") == 48000 * 4, "offline analyzes all frames");
  const double measured = json_utils::fieldNumber(json, "integratedLufs").value_or(NAN);
  const double difference = std::abs(measured - meter.integratedLufs());
  const double referenceError = std::abs(measured - reference(weight));
  maxAgreementError = std::max(maxAgreementError, difference);
  maxReferenceError = std::max(maxReferenceError, referenceError);
  check(std::isfinite(difference) && difference <= 0.051,
        std::string(name) + " offline/exact-PCM realtime agreement within histogram resolution");
  check(std::isfinite(referenceError) && referenceError <= 0.015,
        std::string(name) + " independent K-weighted energy reference");
  const double expectedPeak = 20 * std::log10(lfeAmplitude > 0 ? lfeAmplitude : 0.1);
  check(std::abs(json_utils::fieldNumber(json, "truePeakDb").value_or(NAN) - expectedPeak) < 0.02,
        "offline true peak includes LFE regardless of its loudness weight");
  std::cout << "{\"case\":\"" << name << "\",\"mask\":\"0x" << std::hex << mask << std::dec
            << "\",\"offlineLufs\":" << measured << ",\"realtimeLufs\":" << meter.integratedLufs()
            << ",\"referenceLufs\":" << reference(weight) << ",\"agreementErrorLu\":" << difference << "}\n";

  // Use the same real decoder through CUE and album entry points, retaining
  // the native layout in every member's independent measurement state.
  const auto batch = analyze(engine, path, "{\"segments\":[{\"source\":\"" + path +
      "\",\"startSeconds\":1,\"endSeconds\":3}],\"album\":true}");
  const auto tracks = json_utils::splitTopLevelObjects(json_utils::fieldArray(batch, "tracks"));
  check(tracks.size() == 1, "CUE batch returned its measured member");
  if (tracks.size() == 1) {
    check(json_utils::fieldNumber(tracks[0], "analyzedFrames") == 96000, "CUE exact frame range");
    check(std::abs(json_utils::fieldNumber(tracks[0], "integratedLufs").value_or(NAN) - measured) < 0.002,
          "CUE retains layout weights");
  }
  const auto album = json_utils::fieldObject(batch, "album");
  check(json_utils::fieldNumber(album, "algorithmVersion") == 3, "album invalidates old algorithm identity");
  check(std::abs(json_utils::fieldNumber(album, "integratedLufs").value_or(NAN) - measured) < 0.002,
        "album aggregation retains each member's weights");
}
}  // namespace

int main() {
  Fixtures fixtures;
  TAE_EngineHandle engine = nullptr;
  check(TAE_CreateEngine(&engine) == TAE_RESULT_OK, "create analysis engine without opening output");
  verify(engine, fixtures, "2.1-LFE-only", 0xb, 4, 0);
  verify(engine, fixtures, "2.1-front-and-loud-LFE", 0xb, 1, 1, 0.8);
  verify(engine, fixtures, "3.0-centre", 0x7, 4, 1);
  verify(engine, fixtures, "quad-surround", 0x33, 4, 1.41);
  verify(engine, fixtures, "5.0-surround", 0x37, 8, 1.41);
  verify(engine, fixtures, "quad-side", 0x603, 4, 1.41);
  verify(engine, fixtures, "5.1-surround", 0x3f, 16, 1.41);
  verify(engine, fixtures, "5.1-side", 0x60f, 16, 1.41);
  verify(engine, fixtures, "6.0-back-centre", 0x707, 8, 1);
  verify(engine, fixtures, "7.1-back", 0x63f, 16, 1);
  verify(engine, fixtures, "7.1-side", 0x63f, 64, 1.41);
  verify(engine, fixtures, "7.1-all", 0x63f, 0xff, 7.82);
  verify(engine, fixtures, "7.1-wide", 0xff, 0xff, 7.82);
  verify(engine, fixtures, "top-front", 0x1003, 4, 1);
  verify(engine, fixtures, "top-back", 0x8003, 4, 1);
  {
    // Different native layouts share album gating, not their channel tables.
    const auto first = fixtures.paths[1].generic_string();
    const auto second = fixtures.paths[10].generic_string();
    const auto json = analyze(engine, first, "{\"segments\":[{\"source\":\"" + first +
        "\"},{\"source\":\"" + second + "\"}],\"album\":true}");
    const auto tracks = json_utils::splitTopLevelObjects(json_utils::fieldArray(json, "tracks"));
    check(tracks.size() == 2, "mixed 2.1/7.1 album has two independently measured members");
    const auto album = json_utils::fieldObject(json, "album");
    check(std::abs(json_utils::fieldNumber(album, "integratedLufs").value_or(NAN) -
          reference((1 + 1.41) / 2)) < 0.015, "mixed-layout album combines correctly weighted linear energy");
    check(std::abs(json_utils::fieldNumber(album, "truePeakDb").value_or(NAN) -
          20 * std::log10(0.8)) < 0.02, "mixed-layout album includes loud LFE in true peak");
  }
  {
    // Preserve the analyzer's original >8-channel default downmix contract;
    // the source mask must not be attached to the reduced channel count.
    std::vector<float> pcm;
    const auto path = fixtures.write(0x73f, 1, 0, pcm);
    const auto json = analyze(engine, path);
    check(!json_utils::fieldString(json, "error").has_value(), "nine-channel source retains offline downmix: " + json);
    check(json_utils::fieldNumber(json, "channels") == 8, "offline downmix reports eight actual decoded channels");
    check(json_utils::fieldNumber(json, "analyzedFrames") == 192000, "offline downmix analyzes the entire source");
  }
  TAE_DestroyEngine(engine);
  std::cout << "{\"suite\":\"loudness-layout-offline\",\"scenarios\":17,\"checks\":" << checks
            << ",\"failures\":" << failures << ",\"maxAgreementErrorLu\":" << maxAgreementError
            << ",\"maxReferenceErrorLu\":" << maxReferenceError << "}\n";
  return failures == 0 ? 0 : 1;
}
