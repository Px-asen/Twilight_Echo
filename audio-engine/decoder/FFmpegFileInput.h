#pragma once

#if defined(TAE_HAS_FFMPEG)
#include "SeekableInputStream.h"

#include <cerrno>
#include <cstdio>
#include <string>

extern "C" {
#include <libavformat/avformat.h>
#include <libavutil/mem.h>
}

namespace twilight::audio {

// FFmpeg's Windows file protocol does not share delete access. Supply custom
// seekable IO for local files and host-granted bytes. Other protocol sources
// retain FFmpeg's own IO.
// The owning format context must be closed before this object is destroyed.
class FFmpegFileInput {
 public:
  FFmpegFileInput() = default;
  FFmpegFileInput(const FFmpegFileInput&) = delete;
  FFmpegFileInput& operator=(const FFmpegFileInput&) = delete;
  ~FFmpegFileInput() { close(); }

  bool open(const std::string& source, AVFormatContext** formatContext, std::shared_ptr<SeekableInput> input = {}) {
    close();
    if (input) file_.open(std::move(input));
    else {
#if defined(_WIN32)
    const auto colon = source.find(':');
    const bool drivePath = colon == 1 &&
        ((source[0] >= 'A' && source[0] <= 'Z') || (source[0] >= 'a' && source[0] <= 'z'));
    if (colon != std::string::npos && !drivePath) return true;
      if (!file_.open(source)) return false;
#else
      (void)source;
      return true;
#endif
    }
    auto* buffer = static_cast<unsigned char*>(av_malloc(32768));
    if (!buffer) { close(); return false; }
    io_ = avio_alloc_context(buffer, 32768, 0, this, read, nullptr, seek);
    if (!io_) { av_free(buffer); close(); return false; }
    *formatContext = avformat_alloc_context();
    if (!*formatContext) { close(); return false; }
    (*formatContext)->pb = io_;
    (*formatContext)->flags |= AVFMT_FLAG_CUSTOM_IO;
    return true;
  }

  void close() {
    if (io_) {
      av_freep(&io_->buffer);
      avio_context_free(&io_);
    }
    file_.close();
  }

 private:
  static int read(void* opaque, uint8_t* bytes, int count) {
    auto& file = static_cast<FFmpegFileInput*>(opaque)->file_;
    file.read(reinterpret_cast<char*>(bytes), count);
    const auto readCount = file.gcount();
    if (readCount > 0) return static_cast<int>(readCount);
    return file.failed() ? AVERROR(EIO) : AVERROR_EOF;
  }

  static int64_t seek(void* opaque, int64_t offset, int whence) {
    auto& file = static_cast<FFmpegFileInput*>(opaque)->file_;
    file.clear();
    if (whence == AVSEEK_SIZE) {
      const auto position = file.tellg();
      if (position < 0) return AVERROR(EIO);
      file.seekg(0, std::ios::end);
      const auto size = file.tellg();
      file.seekg(position);
      return file && size >= 0 ? static_cast<int64_t>(size) : AVERROR(EIO);
    }
    whence &= ~AVSEEK_FORCE;
    const auto direction = whence == SEEK_SET ? std::ios::beg
                           : whence == SEEK_CUR ? std::ios::cur : std::ios::end;
    if (whence != SEEK_SET && whence != SEEK_CUR && whence != SEEK_END) return AVERROR(EINVAL);
    file.seekg(offset, direction);
    const auto position = file.tellg();
    return file && position >= 0 ? static_cast<int64_t>(position) : AVERROR(EIO);
  }

  SeekableInputStream file_;
  AVIOContext* io_ = nullptr;
};

}  // namespace twilight::audio
#endif
