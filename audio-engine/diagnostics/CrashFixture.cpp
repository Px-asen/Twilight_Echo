#include <cstdio>
#include "CrashCaptureRegistration.h"
int main() {
  twilight::diagnostics::registerCrashCapture();
  // Test executable only; never installed with the application.
  RaiseException(0xC00000FF, EXCEPTION_NONCONTINUABLE, 0, nullptr);
  return 1;
}
