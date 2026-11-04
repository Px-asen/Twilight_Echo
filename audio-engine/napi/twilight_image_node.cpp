#include <node_api.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/imgutils.h>
#include <libswscale/swscale.h>
}

namespace {
struct CodecDelete { void operator()(AVCodecContext* p) const { avcodec_free_context(&p); } };
struct FrameDelete { void operator()(AVFrame* p) const { av_frame_free(&p); } };
struct PacketDelete { void operator()(AVPacket* p) const { av_packet_free(&p); } };
using Codec = std::unique_ptr<AVCodecContext, CodecDelete>;
using Frame = std::unique_ptr<AVFrame, FrameDelete>;
using Packet = std::unique_ptr<AVPacket, PacketDelete>;
struct Raster { int width = 0, height = 0; std::vector<uint8_t> data; };

// FFmpeg decoders consume memory only. No demuxer, file, URL or audio device is opened.
Raster thumbnail(const uint8_t* data, size_t length, const std::string& mime, int edge, int width, int height) {
  Frame decoded(av_frame_alloc());
  if (!decoded) return {};
  if (mime == "image/rgba") {
    if (width < 1 || height < 1 || static_cast<int64_t>(width) * height > 32 * 1024 * 1024 ||
        static_cast<uint64_t>(width) * height * 4 != length) return {};
    decoded->width = width; decoded->height = height; decoded->format = AV_PIX_FMT_RGBA;
    av_image_fill_arrays(decoded->data, decoded->linesize, data, AV_PIX_FMT_RGBA, width, height, 1);
  } else {
    const AVCodecID id = mime == "image/jpeg" ? AV_CODEC_ID_MJPEG : mime == "image/webp" ? AV_CODEC_ID_WEBP : AV_CODEC_ID_NONE;
    if (id == AV_CODEC_ID_NONE || length == 0 || length > 25 * 1024 * 1024) return {};
    const AVCodec* decoder = avcodec_find_decoder(id);
    if (!decoder) return {};
    Codec dec(avcodec_alloc_context3(decoder));
    Packet input(av_packet_alloc());
    if (!dec || !input) return {};
    dec->max_pixels = 32 * 1024 * 1024;
    dec->thread_count = 1;
    if (avcodec_open2(dec.get(), decoder, nullptr) < 0 || av_new_packet(input.get(), static_cast<int>(length)) < 0) return {};
    std::memcpy(input->data, data, length);
    if (avcodec_send_packet(dec.get(), input.get()) < 0 || avcodec_receive_frame(dec.get(), decoded.get()) < 0) return {};
  }
  if (decoded->width < 1 || decoded->height < 1 ||
      static_cast<int64_t>(decoded->width) * decoded->height > 32 * 1024 * 1024) return {};

  edge = std::min(edge, std::max(decoded->width, decoded->height));
  const double scale = static_cast<double>(edge) / std::max(decoded->width, decoded->height);
  Raster result;
  result.width = std::max(1, static_cast<int>(decoded->width * scale));
  result.height = std::max(1, static_cast<int>(decoded->height * scale));
  result.data.resize(static_cast<size_t>(result.width) * result.height * 4);
  uint8_t* planes[4] = {result.data.data(), nullptr, nullptr, nullptr};
  const int stride[4] = {result.width * 4, 0, 0, 0};
  SwsContext* sws = sws_getContext(decoded->width, decoded->height, static_cast<AVPixelFormat>(decoded->format),
      result.width, result.height, AV_PIX_FMT_RGBA, SWS_LANCZOS, nullptr, nullptr, nullptr);
  if (!sws) return {};
  const int rows = sws_scale(sws, decoded->data, decoded->linesize, 0, decoded->height, planes, stride);
  sws_freeContext(sws);
  return rows == result.height ? result : Raster{};
}

napi_value Resize(napi_env env, napi_callback_info info) {
  napi_value args[5], result;
  size_t argc = 5;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  void* data = nullptr;
  size_t length = 0, chars = 0;
  char mime[32] = {};
  double edge = 0, width = 0, height = 0;
  if (argc != 5 || napi_get_buffer_info(env, args[0], &data, &length) != napi_ok ||
      napi_get_value_string_utf8(env, args[1], mime, sizeof(mime), &chars) != napi_ok || chars >= sizeof(mime) - 1 ||
      napi_get_value_double(env, args[2], &edge) != napi_ok || edge < 1 || edge > 500 || std::floor(edge) != edge ||
      napi_get_value_double(env, args[3], &width) != napi_ok || width < 0 || width > 8192 || std::floor(width) != width ||
      napi_get_value_double(env, args[4], &height) != napi_ok || height < 0 || height > 8192 || std::floor(height) != height) {
    napi_throw_type_error(env, nullptr, "resize requires bitmap bytes, MIME, edge, width and height");
    return nullptr;
  }
  const auto raster = thumbnail(static_cast<const uint8_t*>(data), length, mime, static_cast<int>(edge), static_cast<int>(width), static_cast<int>(height));
  if (raster.data.empty()) { napi_get_undefined(env, &result); return result; }
  napi_create_object(env, &result);
  napi_value value;
  napi_create_double(env, raster.width, &value); napi_set_named_property(env, result, "width", value);
  napi_create_double(env, raster.height, &value); napi_set_named_property(env, result, "height", value);
  napi_create_buffer_copy(env, raster.data.size(), raster.data.data(), nullptr, &value);
  napi_set_named_property(env, result, "data", value);
  return result;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "resize", NAPI_AUTO_LENGTH, Resize, nullptr, &fn);
  napi_set_named_property(env, exports, "resize", fn);
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
