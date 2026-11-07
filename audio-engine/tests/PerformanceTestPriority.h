#pragma once

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

// Match the existing audio pipeline benchmark's scheduling policy. The timing
// thresholds and observed deadline misses remain unchanged.
class ScopedPerformanceTestThreadPriority {
 public:
  ScopedPerformanceTestThreadPriority() {
#ifdef _WIN32
    thread_ = GetCurrentThread();
    previousPriority_ = GetThreadPriority(thread_);
    if (previousPriority_ != THREAD_PRIORITY_ERROR_RETURN)
      changed_ = SetThreadPriority(thread_, THREAD_PRIORITY_ABOVE_NORMAL) != FALSE;
#endif
  }
  ~ScopedPerformanceTestThreadPriority() {
#ifdef _WIN32
    if (changed_) SetThreadPriority(thread_, previousPriority_);
#endif
  }
  ScopedPerformanceTestThreadPriority(const ScopedPerformanceTestThreadPriority&) = delete;
  ScopedPerformanceTestThreadPriority& operator=(const ScopedPerformanceTestThreadPriority&) = delete;
 private:
#ifdef _WIN32
  HANDLE thread_ = nullptr;
  int previousPriority_ = THREAD_PRIORITY_ERROR_RETURN;
  bool changed_ = false;
#endif
};
