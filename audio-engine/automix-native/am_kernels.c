#include "am_kernels.h"

#include <float.h>
#include <math.h>
#include <stdint.h>
#include <string.h>
#if defined(_WIN64)
_Static_assert(sizeof(ta_am_frame_mix) == 56 &&
                   offsetof(ta_am_frame_mix, frames) == 40 &&
                   offsetof(ta_am_frame_mix, channels) == 48 &&
                   offsetof(ta_am_frame_mix, gain_stride) == 52,
               "Win64 frame mix ABI");
#endif
#if defined(TA_AM_HAVE_NASM)
#if defined(_MSC_VER)
#include <intrin.h>
#else
#include <cpuid.h>
#endif
#endif

void ta_am_c_axpy(float *d, const float *s, float x, size_t n) {
  for (size_t i = 0; i < n; i++)
    d[i] += s[i] * x;
}
float ta_am_c_dot(const float *a, const float *b, size_t n) {
  float x = 0;
  for (size_t i = 0; i < n; i++)
    x += a[i] * b[i];
  return x;
}
/* Independent output lanes stay in registers; each lane still accumulates p
 * in source order, with separate multiply/add under the strict FP flags. */
static void gemm_4x8(const float *a, const float *b, float *c, size_t k,
                     size_t n) {
  float s0[8] = {0}, s1[8] = {0}, s2[8] = {0}, s3[8] = {0};
  for (size_t p = 0; p < k; p++) {
    float a0 = a[p], a1 = a[k + p], a2 = a[2 * k + p],
          a3 = a[3 * k + p];
    const float *row = b + p * n;
    for (size_t j = 0; j < 8; j++) {
      s0[j] += a0 * row[j];
      s1[j] += a1 * row[j];
      s2[j] += a2 * row[j];
      s3[j] += a3 * row[j];
    }
  }
  memcpy(c, s0, sizeof(s0));
  memcpy(c + n, s1, sizeof(s1));
  memcpy(c + 2 * n, s2, sizeof(s2));
  memcpy(c + 3 * n, s3, sizeof(s3));
}
void ta_am_c_gemm(const float *a, const float *b, float *c, size_t m, size_t k,
                  size_t n) {
  memset(c, 0, m * n * sizeof(float));
  size_t i = 0;
  for (; i + 4 <= m; i += 4) {
    size_t j = 0;
    for (; j + 8 <= n; j += 8)
      gemm_4x8(a + i * k, b + j, c + i * n + j, k, n);
    for (size_t r = 0; r < 4; r++)
      for (size_t p = 0; p < k; p++)
        ta_am_c_axpy(c + (i + r) * n + j, b + p * n + j,
                      a[(i + r) * k + p], n - j);
  }
  for (; i < m; i++)
    for (size_t p = 0; p < k; p++)
      ta_am_c_axpy(c + i * n, b + p * n, a[i * k + p], n);
}
void ta_am_c_mix(float *d, const float *a, const float *b, const float *ga,
                 const float *gb, size_t n) {
  for (size_t i = 0; i < n; i++)
    d[i] = a[i] * ga[i] + b[i] * gb[i];
}
void ta_am_c_linear(float *d, float first, float last, size_t n) {
  if (!n)
    return;
  float step = n > 1 ? (last - first) / (float)(n - 1) : 0;
  for (size_t i = 0; i < n; i++)
    d[i] = first + (float)i * step;
}
void ta_am_c_butterfly(float *ar, float *ai, float *br, float *bi,
                       const float *wr, const float *wi, size_t n) {
  for (size_t i = 0; i < n; i++) {
    float r = br[i] * wr[i] - bi[i] * wi[i], q = br[i] * wi[i] + bi[i] * wr[i];
    float a = ar[i], b = ai[i];
    ar[i] = a + r;
    ai[i] = b + q;
    br[i] = a - r;
    bi[i] = b - q;
  }
}
void ta_am_c_binary(float *d, const float *a, const float *b, size_t n,
                    unsigned op) {
  for (size_t i = 0; i < n; i++)
    d[i] = op == 0 ? a[i] + b[i] : op == 1 ? a[i] * b[i] : a[i] / b[i];
}
void ta_am_c_affine(float *d, const float *a, float s, float b, size_t n) {
  for (size_t i = 0; i < n; i++)
    d[i] = a[i] * s + b;
}
void ta_am_c_unary(float *d, const float *a, size_t n, unsigned op) {
  for (size_t i = 0; i < n; i++) {
    float x = a[i];
    d[i] = op == 0   ? expf(x)
           : op == 1 ? erff(x)
           : op == 2 ? (x >= 0 ? 1 / (1 + expf(-x)) : expf(x) / (1 + expf(x)))
           : op == 3 ? fmaxf(0, x)
           : op == 4 ? -x
           : op == 5 ? sqrtf(x)
           : op == 6 ? logf(x)
                     : log1pf(x);
  }
}
/* Softmax scores have already had their maximum subtracted. This is the same
 * sixth-order range reduction used by the Win64 activation kernel. */
void ta_am_c_exp_negative(float *x, size_t n) {
  for (size_t i = 0; i < n; i++) {
    float value = x[i];
    if (!(value >= -87.0f)) {
      x[i] = value < 0 ? 0 : value; /* Preserve NaN for graph error reporting. */
      continue;
    }
    int exponent = (int)(value * 1.4426950408889634f - 0.5f);
    float r = value - exponent * 0.693145751953125f;
    r -= exponent * 0.000001428606765330187f;
    float p = 0.001388888888888889f;
    p = p * r + 0.008333333333333333f;
    p = p * r + 0.041666666666666664f;
    p = p * r + 0.16666666666666666f;
    p = p * r + 0.5f;
    p = p * r + 1;
    p = p * r + 1;
    uint32_t bits = (uint32_t)(exponent + 127) << 23;
    float scale;
    memcpy(&scale, &bits, sizeof(scale));
    x[i] = p * scale;
  }
}
void ta_am_c_window(float *d, const float *x, const float *w, size_t n,
                    size_t stride, unsigned add) {
  for (size_t i = 0; i < n; i++) {
    if (add)
      d[i * stride] += x[i] * w[i];
    else
      d[i] = x[i * stride] * w[i];
  }
}
void ta_am_c_normalise(float *d, const float *normalisation, size_t n,
                       size_t stride) {
  for (size_t i = 0; i < n; i++)
    d[i * stride] /= fmaxf(normalisation[i], 1e-12f);
}
void ta_am_c_crossfade_gain(float *a, float *b, float gain, size_t frames,
                            unsigned channels) {
  for (size_t i = 0; i < frames; i++) {
    double t = frames > 1 ? (double)i / (frames - 1) : 0;
    float ga = (float)cos(t * 1.5707963267948966),
          gb = (float)sin(t * 1.5707963267948966);
    float correction = gain + (1 - gain) * (float)t;
    if (!i) { ga = 1; gb = 0; }
    else if (i + 1 == frames) { ga = 0; gb = 1; correction = 1; }
    for (unsigned c = 0; c < channels; c++) {
      a[i * channels + c] = ga;
      b[i * channels + c] = gb * correction;
    }
  }
}
double ta_am_c_sum(const float *x, size_t n, size_t stride) {
  double sum = 0;
  for (size_t i = 0; i < n; i++)
    sum += x[i * stride];
  return sum;
}
float ta_am_c_maximum(const float *x, size_t n, size_t stride) {
  float maximum = -FLT_MAX;
  for (size_t i = 0; i < n; i++)
    maximum = fmaxf(maximum, x[i * stride]);
  return maximum;
}
void ta_am_c_clamp(float *d, const float *x, float lo, float hi, size_t n) {
  for (size_t i = 0; i < n; i++)
    d[i] = fminf(hi, fmaxf(lo, x[i]));
}
double ta_am_c_source_at(double start, float first, float last, size_t frames,
                         double frame) {
  double ramp = frames * 0.8, t = fmax(0, fmin((double)frames, frame));
  if (t <= ramp)
    return start + t * first;
  double x = t - ramp, width = frames - ramp;
  return start + ramp * first + x * first +
         (last - first) * x * x / (2 * width);
}
void ta_am_c_complex(float *d, const float *a, const float *b, size_t n,
                     unsigned conjugate) {
  for (size_t i = 0; i < n; i++) {
    float ar = a[2 * i], ai = a[2 * i + 1], br = b[2 * i],
          bi = conjugate ? -b[2 * i + 1] : b[2 * i + 1];
    d[2 * i] = ar * br - ai * bi;
    d[2 * i + 1] = ar * bi + ai * br;
  }
}
float ta_am_c_reduce(const float *x, size_t n, size_t stride, unsigned square) {
  float sum = 0;
  for (size_t i = 0; i < n; i++) {
    float value = x[i * stride];
    sum += square ? value * value : value;
  }
  return sum;
}
void ta_am_c_moments(const float *x, size_t n, double *energy, float *peak) {
  double sum = 0;
  float maximum = 0;
  for (size_t i = 0; i < n; i++) {
    sum += (double)x[i] * x[i];
    maximum = fmaxf(maximum, fabsf(x[i]));
  }
  *energy = sum;
  *peak = maximum;
}
void ta_am_c_lowpass_exit(float *x, size_t frames, unsigned channels,
                          const float *alpha, const float *blend) {
  float state[8] = {0};
  for (size_t i = 0; i < frames; i++)
    for (unsigned c = 0; c < channels; c++) {
      size_t index = i * channels + c;
      state[c] += alpha[i] * (x[index] - state[c]);
      x[index] = x[index] * (1 - blend[i]) + state[c] * blend[i];
    }
}
void ta_am_c_downmix(float *mono, const float *x, size_t frames) {
  double mid = 0, left = 0, right = 0;
  for (size_t i = 0; i < frames; i++) {
    double m = (x[2 * i] + x[2 * i + 1]) * 0.5;
    mid += m * m;
    left += (double)x[2 * i] * x[2 * i];
    right += (double)x[2 * i + 1] * x[2 * i + 1];
  }
  unsigned channel = right > left ? 1 : 0;
  int cancellation = mid < fmax(left, right) * 0.02;
  for (size_t i = 0; i < frames; i++)
    mono[i] =
        cancellation ? x[2 * i + channel] : (x[2 * i] + x[2 * i + 1]) * 0.5f;
}
void ta_am_c_mix_frames(const ta_am_frame_mix *m) {
  for (size_t frame = 0; frame < m->frames; frame++)
    for (unsigned c = 0; c < m->channels; c++) {
      size_t i = frame * m->channels + c;
      m->destination[i] =
          m->current[i] * m->current_gain[frame * m->gain_stride] +
          m->next[i] * m->next_gain[frame * m->gain_stride];
    }
}
void ta_am_c_headroom_envelope(float *gain, size_t frames, unsigned rate) {
  if (!frames || !rate) return;
  float release = 1 / (rate * .3f), attack = 1 / (rate * .06f);
  for (size_t i = 1; i < frames; i++)
    gain[i] = fminf(gain[i], gain[i - 1] + release);
  for (size_t i = frames - 1; i > 0; i--)
    gain[i - 1] = fminf(gain[i - 1], gain[i] + attack);
  // Preserve the exact source join. Only the first/last 10ms relax the
  // prediction ceiling; source peaks there must be reported separately.
  float edge = 1 / (rate * .01f);
  for (size_t i = 0; i < frames; i++) {
    float floor = fmaxf(0, 1 - (float)i * edge);
    floor = fmaxf(floor, 1 - (float)(frames - 1 - i) * edge);
    gain[i] = fmaxf(gain[i], floor);
  }
}
static const ta_am_kernels c_table = {TA_AM_C,
                                      ta_am_c_axpy,
                                      ta_am_c_dot,
                                      ta_am_c_gemm,
                                      ta_am_c_mix,
                                      ta_am_c_linear,
                                      ta_am_c_butterfly,
                                      ta_am_c_binary,
                                      ta_am_c_affine,
                                      ta_am_c_unary,
                                      ta_am_c_complex,
                                      ta_am_c_phase,
                                      ta_am_c_window,
                                      ta_am_c_normalise,
                                      ta_am_c_crossfade_gain,
                                      ta_am_c_sum,
                                      ta_am_c_maximum,
                                      ta_am_c_clamp,
                                      ta_am_c_source_at,
                                      ta_am_c_reduce,
                                      ta_am_c_moments,
                                      ta_am_c_lowpass_exit,
                                      ta_am_c_downmix,
                                      ta_am_c_mix_frames,
                                      ta_am_c_headroom_envelope};
#if defined(TA_AM_HAVE_NASM)
#define DECLARE(suffix)                                                        \
  extern void ta_am_axpy_##suffix(float *, const float *, float, size_t);      \
  extern float ta_am_dot_##suffix(const float *, const float *, size_t);       \
  extern void ta_am_gemm_##suffix(const float *, const float *, float *,       \
                                  size_t, size_t, size_t);                     \
  extern void ta_am_mix_##suffix(float *, const float *, const float *,        \
                                 const float *, const float *, size_t);        \
  extern void ta_am_linear_##suffix(float *, float, float, size_t);            \
  extern void ta_am_butterfly_##suffix(float *, float *, float *, float *,     \
                                       const float *, const float *, size_t);  \
  extern void ta_am_binary_##suffix(float *, const float *, const float *,     \
                                    size_t, unsigned);                         \
  extern void ta_am_affine_##suffix(float *, const float *, float, float,      \
                                    size_t);                                   \
  extern void ta_am_unary_##suffix(float *, const float *, size_t, unsigned);  \
  extern void ta_am_complex_##suffix(float *, const float *, const float *,    \
                                     size_t, unsigned);                        \
  extern void ta_am_phase_##suffix(ta_am_phase_state *);                       \
  extern void ta_am_window_##suffix(float *, const float *, const float *,     \
                                    size_t, size_t, unsigned);                 \
  extern void ta_am_normalise_##suffix(float *, const float *, size_t,         \
                                       size_t);                                \
  extern void ta_am_crossfade_gain_##suffix(float *, float *, float, size_t,   \
                                            unsigned);                         \
  extern double ta_am_sum_##suffix(const float *, size_t, size_t);             \
  extern float ta_am_maximum_##suffix(const float *, size_t, size_t);          \
  extern void ta_am_clamp_##suffix(float *, const float *, float, float,       \
                                   size_t);                                    \
  extern double ta_am_source_at_##suffix(double, float, float, size_t,         \
                                         double);                              \
  extern float ta_am_reduce_##suffix(const float *, size_t, size_t, unsigned); \
  extern void ta_am_moments_##suffix(const float *, size_t, double *,          \
                                     float *);                                 \
  extern void ta_am_lowpass_exit_##suffix(float *, size_t, unsigned,           \
                                          const float *, const float *);       \
  extern void ta_am_downmix_##suffix(float *, const float *, size_t);          \
  extern void ta_am_mix_frames_##suffix(const ta_am_frame_mix *);               \
  extern void ta_am_headroom_envelope_##suffix(float *, size_t, unsigned)
DECLARE(sse2);
DECLARE(avx2);
static const ta_am_kernels sse_table = {TA_AM_SSE2,
                                        ta_am_axpy_sse2,
                                        ta_am_dot_sse2,
                                        ta_am_gemm_sse2,
                                        ta_am_mix_sse2,
                                        ta_am_linear_sse2,
                                        ta_am_butterfly_sse2,
                                        ta_am_binary_sse2,
                                        ta_am_affine_sse2,
                                        ta_am_unary_sse2,
                                        ta_am_complex_sse2,
                                        ta_am_phase_sse2,
                                        ta_am_window_sse2,
                                        ta_am_normalise_sse2,
                                        ta_am_crossfade_gain_sse2,
                                        ta_am_sum_sse2,
                                        ta_am_maximum_sse2,
                                        ta_am_clamp_sse2,
                                        ta_am_source_at_sse2,
                                        ta_am_reduce_sse2,
                                        ta_am_moments_sse2,
                                        ta_am_lowpass_exit_sse2,
                                        ta_am_downmix_sse2,
                                        ta_am_mix_frames_sse2,
                                        ta_am_headroom_envelope_sse2};
static const ta_am_kernels avx_table = {TA_AM_AVX2,
                                        ta_am_axpy_avx2,
                                        ta_am_dot_avx2,
                                        ta_am_gemm_avx2,
                                        ta_am_mix_avx2,
                                        ta_am_linear_avx2,
                                        ta_am_butterfly_avx2,
                                        ta_am_binary_avx2,
                                        ta_am_affine_avx2,
                                        ta_am_unary_avx2,
                                        ta_am_complex_avx2,
                                        ta_am_phase_avx2,
                                        ta_am_window_avx2,
                                        ta_am_normalise_avx2,
                                        ta_am_crossfade_gain_avx2,
                                        ta_am_sum_avx2,
                                        ta_am_maximum_avx2,
                                        ta_am_clamp_avx2,
                                        ta_am_source_at_avx2,
                                        ta_am_reduce_avx2,
                                        ta_am_moments_avx2,
                                        ta_am_lowpass_exit_avx2,
                                        ta_am_downmix_avx2,
                                        ta_am_mix_frames_avx2,
                                        ta_am_headroom_envelope_avx2};
static int avx2_available(void) {
#if defined(_MSC_VER)
  unsigned c;
  int r[4];
  __cpuid(r, 0);
  if (r[0] < 7)
    return 0;
  __cpuidex(r, 1, 0);
  c = (unsigned)r[2];
  if ((c & ((1u << 27) | (1u << 28))) != ((1u << 27) | (1u << 28)))
    return 0;
  if ((_xgetbv(0) & 6) != 6)
    return 0;
  __cpuidex(r, 7, 0);
  return !!(r[1] & (1 << 5));
#else
  unsigned a, b, c, d;
  if (__get_cpuid_max(0, 0) < 7)
    return 0;
  __cpuid_count(1, 0, a, b, c, d);
  if ((c & ((1u << 27) | (1u << 28))) != ((1u << 27) | (1u << 28)))
    return 0;
  unsigned lo, hi;
  __asm__ volatile("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
  if ((lo & 6) != 6)
    return 0;
  __cpuid_count(7, 0, a, b, c, d);
  return !!(b & (1u << 5));
#endif
}
#endif
const ta_am_kernels *ta_am_get_kernels(ta_am_cpu cpu) {
  if (cpu == TA_AM_C)
    return &c_table;
#if defined(TA_AM_HAVE_NASM)
  if (cpu == TA_AM_AUTO)
    return avx2_available() ? &avx_table : &sse_table;
  if (cpu == TA_AM_SSE2)
    return &sse_table;
  if (cpu == TA_AM_AVX2 && avx2_available())
    return &avx_table;
#else
  if (cpu == TA_AM_AUTO)
    return &c_table;
#endif
  return NULL;
}
const char *ta_am_cpu_name(ta_am_cpu cpu) {
  switch (cpu) {
  case TA_AM_AUTO:
    return "auto";
  case TA_AM_C:
    return "c11";
  case TA_AM_SSE2:
    return "sse2";
  case TA_AM_AVX2:
    return "avx2";
  default:
    return "unavailable";
  }
}
