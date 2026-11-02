#include "../dsp/DspWorkspaceProcessors.h"

#include <algorithm>
#include <array>
#include <cstdio>
#include <vector>

using namespace twilight::audio;

namespace {
int checks=0,failures=0;
void check(bool pass,const char* name,int channels,const char* label) {
  ++checks; failures+=!pass;
  std::printf("%s processor=%s channels=%d %s\n",pass ? "PASS":"FAIL",name,channels,label);
}
void testBridge(IAudioProcessor& p,const char* name,DspConfig config,int channels) {
  AudioFormat f; f.sampleRate=48000; f.channelCount=channels;
  p.configure(config); p.prepare(f);
  constexpr size_t frames=17;
  constexpr double sentinel=0.123456789012345;
  const size_t count=frames*channels;
  // Allocate enough padding to observe the original over-conversion without
  // invoking an out-of-bounds access in the regression test itself.
  std::vector<double> data(frames*8+8,sentinel);
  std::vector<float> expected(count);
  for(size_t i=0;i<count;++i) {
    data[i]=double(int(i%19)-9)/64+1e-10;
    expected[i]=static_cast<float>(data[i]);
  }
  const auto input=data;
  p.processDouble(data.data(),frames);
  check(std::all_of(data.begin()+count,data.end(),[](double value){return value==sentinel;}),
        name,channels,"leaves samples after frameCount*preparedChannels untouched");
  p.reset(); p.process(expected.data(),frames);
  bool same=true;
  for(size_t i=0;i<count;++i) same &= data[i] == (p.isActive() ? double(expected[i]):input[i]);
  check(same,name,channels,"matches the declared Float32 bridge result or inactive exact bypass");
  p.reset(); auto fragmented=input;
  for(size_t frame=0;frame<frames;) {
    const auto size=std::min<size_t>((frame%3)+1,frames-frame);
    p.processDouble(fragmented.data()+frame*channels,size); frame+=size;
  }
  check(fragmented==data,name,channels,"preserves samples and padding across irregular double blocks");
  config.enabled=false; p.configure(config); data=input; p.processDouble(data.data(),frames);
  check(data==input,name,channels,"disabled processor is bit-exact including non-Float32 values");
}
} // namespace

int main() {
  for(int channels : {1,2,6,8}) {
    DspConfig c; c.enabled=true;
    c.channelMatrixEnabled=c.channelStripEnabled=c.bassManagementEnabled=true;
    c.dynamicEqEnabled=c.multibandCompressorEnabled=c.stereoFieldEnabled=true;
    c.loudnessContourEnabled=c.compressorEnabled=c.meterEnabled=true;
    c.channelMatrix.resize(channels*channels);
    for(int i=0;i<channels;++i) c.channelMatrix[i*channels+i]=0.75;
    c.channelStripChannels={{-6,1,true,false}};
    DspDynamicEqBand band; band.frequency=1000; band.gainDb=-3; c.dynamicEqBands={band};
    c.multibandCrossoversHz={200}; c.multibandCompressorBands.resize(2);
    c.stereoWidth=1.2; c.loudnessContourAmount=0.5;
    ChannelMatrixProcessor matrix; testBridge(matrix,"channelMatrix",c,channels);
    ChannelStripProcessor strip; testBridge(strip,"channelStrip",c,channels);
    BassManagementProcessor bass; testBridge(bass,"bassManagement",c,channels);
    DynamicEqProcessor eq; testBridge(eq,"dynamicEq",c,channels);
    MultibandCompressorProcessor multi; testBridge(multi,"multibandCompressor",c,channels);
    StereoFieldProcessor stereo; testBridge(stereo,"stereoField",c,channels);
    LoudnessContourProcessor contour; testBridge(contour,"loudnessContour",c,channels);
    DynamicsProcessor compressor(DynamicsMode::Compressor); testBridge(compressor,"compressor",c,channels);
    LoudnessMeterProcessor meter; testBridge(meter,"meter",c,channels);
  }
  std::printf("double-bridge checks=%d failures=%d\n",checks,failures);
  return failures ? 1:0;
}
