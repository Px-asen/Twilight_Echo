#pragma once

#include "SeekableInput.h"
#include "../core/SharedInputFile.h"
#include "../core/Utf8Path.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <istream>

namespace twilight::audio {

// Adapt the host's positional IO to the existing container parsers. The small
// buffer belongs to this cursor; a shared input never shares seek state.
class SeekableInputStream : public std::istream {
  class LocalInput final : public SeekableInput {
   public:
    explicit LocalInput(const std::string& source) : file_(utf8Path(source), std::ios::binary) {}
    bool isOpen() const { return file_.is_open(); }
    int64_t size() override {
      if (cancelled_) return -1;
      file_.clear();
      file_.seekg(0, std::ios::end);
      return static_cast<int64_t>(file_.tellg());
    }
    int readAt(int64_t position, uint8_t* bytes, int count) override {
      if (cancelled_) return -1;
      file_.clear();
      file_.seekg(position, std::ios::beg);
      if (!file_) return -1;
      file_.read(reinterpret_cast<char*>(bytes), count);
      return file_.bad() ? -1 : static_cast<int>(file_.gcount());
    }
    void cancel() override { cancelled_ = true; }

   private:
    SharedInputFile file_;
    std::atomic<bool> cancelled_{false};
  };

  class Buffer final : public std::streambuf {
   public:
    void open(std::shared_ptr<SeekableInput> input) {
      position_ = 0;
      failed_ = false;
      cancelled_ = false;
      setg(nullptr, nullptr, nullptr);
      std::atomic_store(&input_, std::move(input));
    }
    std::shared_ptr<SeekableInput> input() const { return std::atomic_load(&input_); }
    bool failed() const { return failed_ || cancelled_; }
    bool cancel() {
      auto source = input();
      if (!source) return false;
      cancelled_ = true;
      source->cancel();
      return true;
    }

   protected:
    int_type underflow() override {
      if (cancelled_) { failed_ = true; return traits_type::eof(); }
      if (gptr() && gptr() < egptr()) return traits_type::to_int_type(*gptr());
      auto source = input();
      if (!source) return traits_type::eof();
      const int count = source->readAt(position_, reinterpret_cast<uint8_t*>(bytes_.data()), bytes_.size());
      if (count <= 0) {
        if (count < 0) failed_ = true;
        return traits_type::eof();
      }
      position_ += count;
      setg(bytes_.data(), bytes_.data(), bytes_.data() + count);
      return traits_type::to_int_type(*gptr());
    }
    std::streamsize xsgetn(char* output, std::streamsize count) override {
      std::streamsize copied = 0;
      while (copied < count && !traits_type::eq_int_type(underflow(), traits_type::eof())) {
        const auto available = std::min<std::streamsize>(count - copied, egptr() - gptr());
        std::memcpy(output + copied, gptr(), static_cast<size_t>(available));
        gbump(static_cast<int>(available));
        copied += available;
      }
      return copied;
    }
    pos_type seekoff(off_type offset, std::ios::seekdir direction, std::ios::openmode mode) override {
      auto source = input();
      if (!source || cancelled_ || !(mode & std::ios::in)) return pos_type(off_type(-1));
      int64_t base = 0;
      if (direction == std::ios::cur) base = position_ - (gptr() ? egptr() - gptr() : 0);
      else if (direction == std::ios::end) {
        base = source->size();
        if (base < 0) { failed_ = true; return pos_type(off_type(-1)); }
      } else if (direction != std::ios::beg) return pos_type(off_type(-1));
      if (offset < -base) return pos_type(off_type(-1));
      position_ = base + offset;
      setg(nullptr, nullptr, nullptr);
      return pos_type(position_);
    }
    pos_type seekpos(pos_type position, std::ios::openmode mode) override {
      return seekoff(static_cast<off_type>(position), std::ios::beg, mode);
    }

   private:
    std::shared_ptr<SeekableInput> input_;
    std::atomic<bool> failed_{false}, cancelled_{false};
    int64_t position_ = 0;
    std::array<char, 32768> bytes_;
  } buffer_;

 public:
  SeekableInputStream() : std::istream(nullptr) { rdbuf(&buffer_); }
  bool open(const std::string& source, const std::shared_ptr<const SeekableInputFactory>& factory = {}) {
    auto input = factory ? (*factory)(source) : nullptr;
    if (!input) {
      auto local = std::make_shared<LocalInput>(source);
      if (!local->isOpen()) { close(); setstate(std::ios::failbit); return false; }
      input = std::move(local);
    }
    open(std::move(input));
    return true;
  }
  void open(std::shared_ptr<SeekableInput> input) { clear(); buffer_.open(std::move(input)); }
  void close() { buffer_.open({}); clear(); }
  bool is_open() const { return buffer_.input() != nullptr; }
  bool failed() const { return buffer_.failed(); }
  bool cancelInput() { return buffer_.cancel(); }
  std::shared_ptr<SeekableInput> input() const { return buffer_.input(); }
};

}  // namespace twilight::audio
