#include "Vst3ModuleProbe.h"
#include "../diagnostics/CrashCaptureRegistration.h"

#include <windows.h>

#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

std::string utf8(const wchar_t* value) {
  if (!value || !*value) return {};
  const int count = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
  if (count <= 1) return {};
  std::vector<char> output(static_cast<size_t>(count));
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, output.data(), count, nullptr, nullptr);
  return std::string(output.data(), static_cast<size_t>(count - 1));
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  twilight::diagnostics::registerCrashCapture();
  if (argc == 2 && std::wstring_view(argv[1]) == L"--self-test") {
    std::cout << "{\"kind\":\"twilight-vst3-scanner\",\"protocolVersion\":1,\"status\":\"ready\"}";
    return 0;
  }
  if (argc != 3 || std::wstring_view(argv[1]) != L"--module") {
    std::cerr << "Usage: twilight-vst3-scanner --module <module-path>";
    return 64;
  }

  const auto result = twilight::vst3::probeModule(utf8(argv[2]));
  if (!result.ok()) {
    std::cerr << result.error;
    return 2;
  }
  std::cout << twilight::vst3::scannerDescriptorJson(result);
  return 0;
}
