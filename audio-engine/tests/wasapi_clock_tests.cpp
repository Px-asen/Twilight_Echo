#include "../output/wasapi/WasapiClock.h"
#include <cassert>
#include <iostream>
using namespace twilight::audio;

// COM protocol fixtures only; these never enumerate or open an audio device.
class Clock final : public IAudioClock {
 public:
  HRESULT positionResult = S_OK, frequencyResult = S_OK;
  UINT64 frequency = 24000000, position = 12000000, qpc100ns = 14500000;
  ULONG references = 1;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references; }
  ULONG STDMETHODCALLTYPE Release() override { return --references; }
  HRESULT STDMETHODCALLTYPE GetFrequency(UINT64* value) override { *value = frequency; return frequencyResult; }
  HRESULT STDMETHODCALLTYPE GetPosition(UINT64* value, UINT64* time) override { *value = position; *time = qpc100ns; return positionResult; }
  HRESULT STDMETHODCALLTYPE GetCharacteristics(DWORD* value) override { *value = 0; return S_OK; }
};
class Client final : public IAudioClient {
 public:
  Clock clock;
  bool available = true;
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void**) override { return E_NOINTERFACE; }
  ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }
  HRESULT STDMETHODCALLTYPE Initialize(AUDCLNT_SHAREMODE, DWORD, REFERENCE_TIME, REFERENCE_TIME, const WAVEFORMATEX*, LPCGUID) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetBufferSize(UINT32*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetStreamLatency(REFERENCE_TIME*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetCurrentPadding(UINT32*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE IsFormatSupported(AUDCLNT_SHAREMODE, const WAVEFORMATEX*, WAVEFORMATEX**) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetMixFormat(WAVEFORMATEX**) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetDevicePeriod(REFERENCE_TIME*, REFERENCE_TIME*) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Start() override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Stop() override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE Reset() override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE SetEventHandle(HANDLE) override { return E_NOTIMPL; }
  HRESULT STDMETHODCALLTYPE GetService(REFIID iid, void** service) override {
    *service = nullptr;
    if (!available || !IsEqualIID(iid, __uuidof(IAudioClock))) return E_NOINTERFACE;
    clock.AddRef(); *service = static_cast<IAudioClock*>(&clock); return S_OK;
  }
};
int main() {
  Client client;
  wasapi::PresentationClock observation;
  assert(!observation.read().supported);
  observation.attach(&client, 48000);
  auto state = observation.read();
  assert(state.supported && !state.valid && !state.running);
  const auto attachedEpoch = state.epoch;
  observation.begin(); observation.sample(); state = observation.read();
  assert(state.valid && state.running && state.epoch > attachedEpoch);
  assert(state.positionFrames == 24000); // Device units / frequency -> stream frames.
  assert(state.sampledAtMs == 1450); // Correlated QPC is already expressed in 100ns units.
  client.clock.positionResult = S_FALSE;
  observation.sample(); state = observation.read();
  assert(state.supported && state.running && !state.valid && state.positionFrames == 0);
  client.clock.positionResult = E_FAIL;
  observation.sample(); assert(!observation.read().valid);
  client.clock.positionResult = S_OK; client.clock.qpc100ns = 0;
  observation.sample(); assert(!observation.read().valid);
  observation.invalidate(); assert(!observation.read().running);
  observation.detach(); assert(!observation.read().supported);
  assert(client.clock.references == 1);
  client.clock.frequency = 0;
  observation.attach(&client, 48000); assert(!observation.read().supported);
  client.clock.frequency = 24000000; client.clock.frequencyResult = E_FAIL;
  observation.attach(&client, 48000); assert(!observation.read().supported);
  client.available = false;
  observation.attach(&client, 48000); assert(!observation.read().supported);
  assert(client.clock.references == 1);
  std::cout << "WASAPI clock: units, correlated QPC, S_FALSE/failure, epochs and unavailable clocks passed\n";
}
