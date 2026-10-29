#pragma once

#include "AudioTypes.h"
#include <algorithm>
#include <cmath>
#include <optional>
#include <vector>

namespace twilight::audio {

inline bool validPcmSampleRates(const std::vector<int>& rates) {
  auto unique = rates;
  std::sort(unique.begin(), unique.end());
  return rates.size() <= 32 && std::adjacent_find(unique.begin(), unique.end()) == unique.end() &&
      std::all_of(rates.begin(), rates.end(), [](int rate) {
    return rate >= 8000 && rate <= 384000;
  });
}

inline std::vector<int> pcmSampleRateCandidates(const OutputConfig& config) {
  std::vector<int> rates = config.allowedSampleRates.empty() ? config.deviceSampleRates : config.allowedSampleRates;
  if (!config.allowedSampleRates.empty() && !config.deviceSampleRates.empty()) {
    std::erase_if(rates, [&](int rate) {
      return std::find(config.deviceSampleRates.begin(), config.deviceSampleRates.end(), rate) == config.deviceSampleRates.end();
    });
  }
  std::sort(rates.begin(), rates.end());
  rates.erase(std::unique(rates.begin(), rates.end()), rates.end());
  return rates;
}

inline bool pcmSampleRateConstraintsCompatible(const OutputConfig& config) {
  return !(config.sampleRateFamilySync && config.continuityFirst) &&
         validPcmSampleRates(config.allowedSampleRates) && validPcmSampleRates(config.deviceSampleRates) &&
         (config.allowedSampleRates.empty() || config.deviceSampleRates.empty() || !pcmSampleRateCandidates(config).empty());
}

// Family sync preserves an exact source rate if possible, then takes the lowest
// rate in the same 44.1/48 kHz family not below the source, else that family's
// highest lower rate. Without a family match, choose the nearest available rate
// (higher wins ties). No advertised/allowed set leaves the request unchanged.
inline std::optional<int> selectPcmSampleRate(int sourceRate, int preferredRate, const OutputConfig& config,
                                              bool fixedRequest = false) {
  if (!pcmSampleRateConstraintsCompatible(config)) return std::nullopt;
  if (!config.sampleRateFamilySync && config.allowedSampleRates.empty()) return preferredRate;
  auto rates = pcmSampleRateCandidates(config);
  if (rates.empty()) return preferredRate;
  const int desired = config.sampleRateFamilySync ? sourceRate : preferredRate;
  if (fixedRequest && !config.sampleRateFamilySync) {
    return std::binary_search(rates.begin(), rates.end(), preferredRate) ? std::optional<int>(preferredRate) : std::nullopt;
  }
  if (std::binary_search(rates.begin(), rates.end(), desired)) return desired;
  if (config.sampleRateFamilySync) {
    const int family = sourceRate % 11025 == 0 ? 11025 : sourceRate % 8000 == 0 ? 8000 : 0;
    std::vector<int> sameFamily;
    if (family) for (int rate : rates) if (rate % family == 0) sameFamily.push_back(rate);
    if (!sameFamily.empty()) {
      const auto up = std::lower_bound(sameFamily.begin(), sameFamily.end(), sourceRate);
      return up != sameFamily.end() ? *up : sameFamily.back();
    }
  }
  return *std::min_element(rates.begin(), rates.end(), [desired](int a, int b) {
    return std::abs(a - desired) == std::abs(b - desired) ? a > b : std::abs(a - desired) < std::abs(b - desired);
  });
}

} // namespace twilight::audio
