#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace twilight::audio {

// Host-owned bytes; invoked on decode/control workers, never the audio callback.
// Each factory invocation owns an independent cursor/cache and cancellation scope.
class SeekableInput {
 public:
  virtual ~SeekableInput() = default;
  virtual int64_t size() = 0;
  // Positive byte count, 0 at EOF, negative on failure.
  virtual int readAt(int64_t position, uint8_t* bytes, int count) = 0;
  // Thread-safe, nonblocking: unblocks an in-flight size/readAt. Not reversible.
  virtual void cancel() = 0;
  // Optional complete, seekable local file backing these exact bytes. The path
  // stays valid for this reader's lifetime. Empty
  // for network readers, slices and pipes; ordinary playback needs no identity.
  virtual std::string localPath() { return {}; }
  // Optional borrowed POSIX descriptor for the same COMPLETE regular file.
  // It remains open even after cancel(), until this reader is destroyed.
  // Android SAF grants often permit this descriptor but not reopening its path.
  virtual int localFileDescriptor() { return -1; }
};
using SeekableInputFactory = std::function<std::shared_ptr<SeekableInput>(const std::string&)>;

}  // namespace twilight::audio
