#include "../automix-native/BridgeAutoMixPlan.h"
#include <cassert>
#include <iostream>
using namespace twilight::audio;

static ta_am_binding binding(unsigned rate) {
  ta_am_binding b{};
  b.plan_id = 91; b.queue_revision = 17; b.playback_generation = 19; b.format_revision = 23;
  b.sample_rate = rate; b.channels = 2;
  std::memset(b.current_identity, 'a', 64); std::memset(b.next_identity, 'b', 64);
  return b;
}
static std::string replace(std::string input, const std::string& key, const std::string& value) {
  const auto start = json_utils::topLevelFieldValueStart(input, key);
  assert(start);
  size_t end = *start;
  if (input[end] == '"') { ++end; while (end < input.size() && input[end] != '"') ++end; ++end; }
  else while (end < input.size() && input[end] != ',' && input[end] != '}') ++end;
  input.replace(*start, end-*start, value);
  return input;
}
int main() {
  const auto* kernels = ta_am_get_kernels(TA_AM_AUTO);
  BridgeAutoMixSources sources{{"same-file:1", "same-file:2"}, {10, 40}, {70, 100}};
  for (const auto mode : {TA_AM_NATURAL, TA_AM_DJ}) {
    ta_am_plan_spec common{};
    common.binding = binding(48000); common.mode = mode; common.effect = TA_AM_CLEAN;
    common.kind = TA_AM_BEAT_ALIGNED; common.current_start = 48*48000;
    common.next_start = 2*48000; common.output_frames = 6*48000;
    common.current_rate = 1.013f; common.next_rate = .987f; common.next_gain = .75f;
    common.bpm = 120; common.confidence = .9f; common.score = 1.2f;
    common.current_end = ta_am_plan_source_frame(&common, 0, common.output_frames);
    common.next_end = ta_am_plan_source_frame(&common, 1, common.output_frames);
    assert(ta_am_plan_valid(&common, kernels));
    const auto json = bridgeAutoMixPlanJson(common, sources);
    for (const unsigned rate : {44100, 48000, 96000, 192000}) {
      auto local = binding(rate); local.plan_id += rate;
      ta_am_plan_spec actual{}; std::string reason;
      assert(bindBridgeAutoMixPlan(json, local, sources, mode, rate*3, 60, 60, kernels, &actual, &reason));
      assert(ta_am_plan_valid(&actual, kernels));
      assert(actual.binding.plan_id == local.plan_id);
      assert(actual.binding.queue_revision == local.queue_revision);
      assert(actual.binding.format_revision == local.format_revision);
      assert(actual.current_rate == common.current_rate && actual.next_rate == common.next_rate && actual.next_gain == common.next_gain);
      assert(actual.current_start == 48*rate && actual.output_frames == 6*rate);
      const double quantization = .5/48000 + .5/rate + 1e-9;
      assert(std::abs(static_cast<double>(actual.current_end)/rate-static_cast<double>(common.current_end)/48000) <= quantization);
      assert(std::abs(static_cast<double>(actual.next_end)/rate-static_cast<double>(common.next_end)/48000) <= quantization);
      for (const auto& bad : {
          replace(json,"version","2"), replace(json,"ruleVersion","\"old-rules\""),
          replace(json,"currentIdentity","\"wrong\""), replace(json,"nextIdentity","\"wrong\""),
          replace(json,"currentEntryId","\"same-file:2\""), replace(json,"nextEntryId","\"same-file:1\""),
          replace(json,"currentSourceStartSeconds","0"), replace(json,"nextSourceEndSeconds","101"),
          replace(json,"sampleRate","0"), replace(json,"channels","6"), replace(json,"outputFrames","1"),
          replace(json,"currentRate","null"), replace(json,"nextRate","2"), replace(json,"nextGain","3"),
          replace(json,"currentEndFrame","1"), replace(json,"kind","99"), replace(json,"confidence","2"),
          replace(json,"effect","-1"), replace(json,"vocalClash","-1"), replace(json,"lowClash","1e999"),
          json+"trailing" }) {
        assert(!bindBridgeAutoMixPlan(bad,local,sources,mode,rate*3,60,60,kernels,&actual,&reason));
      }
      assert(!bindBridgeAutoMixPlan(json,local,sources,mode,rate*49,60,60,kernels,&actual,&reason));
      assert(reason == "preparation_missed_boundary");
      assert(!bindBridgeAutoMixPlan(json,local,sources,mode,0,50,60,kernels,&actual,&reason));
      assert(!bindBridgeAutoMixPlan(json,local,sources,mode==TA_AM_DJ?TA_AM_NATURAL:TA_AM_DJ,0,60,60,kernels,&actual,&reason));
    }
  }
  // An EOF-adjacent policy remains valid when sample-domain rounding is not
  // exactly distributive. Correction is bounded by the two frame domains.
  ta_am_plan_spec edge{}; edge.binding=binding(48000); edge.mode=TA_AM_NATURAL; edge.kind=TA_AM_CONTENT_BOUNDARY;
  edge.effect=TA_AM_CLEAN; edge.current_rate=edge.next_rate=1; edge.next_gain=1;
  edge.current_start=static_cast<uint64_t>(52.12345*48000); edge.next_start=10;
  edge.output_frames=6*48000; edge.current_end=edge.current_start+edge.output_frames; edge.next_end=edge.next_start+edge.output_frames;
  const double end=static_cast<double>(edge.current_end)/48000;
  for (unsigned rate : {44100,48000,96000}) {
    ta_am_plan_spec actual{}; std::string reason;
    assert(bindBridgeAutoMixPlan(bridgeAutoMixPlanJson(edge,sources),binding(rate),sources,TA_AM_NATURAL,0,end,60,kernels,&actual,&reason));
    assert(actual.current_end <= static_cast<uint64_t>(std::llround(end*rate)));
  }
  std::cout << "Shared AutoMix: one policy, member-local bindings, rate quantization, EOF and stale/tampered rejection passed\n";
}
