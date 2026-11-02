#ifndef TWILIGHT_AM_KERNELS_H
#define TWILIGHT_AM_KERNELS_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef enum {
  TA_AM_AUTO = 0,
  TA_AM_C = 1,
  TA_AM_SSE2 = 2,
  TA_AM_AVX2 = 3
} ta_am_cpu;
typedef struct {
  float r, i;
} ta_am_complex;
typedef struct {
  size_t bins;
  unsigned channels, long_step;
  float time_factor, reserved;
  const ta_am_complex *current, *previous;
  ta_am_complex *output;
  const ta_am_complex *rotation;
  float *energies;
  const float *previous_energies;
} ta_am_phase_state;
typedef struct {
  float *destination;
  const float *current, *next, *current_gain, *next_gain;
  size_t frames;
  unsigned channels, gain_stride;
} ta_am_frame_mix;
typedef struct {
  ta_am_cpu cpu;
  void (*axpy)(float *, const float *, float, size_t);
  float (*dot)(const float *, const float *, size_t);
  void (*gemm)(const float *, const float *, float *, size_t, size_t, size_t);
  void (*mix)(float *, const float *, const float *, const float *,
              const float *, size_t);
  void (*linear)(float *, float, float, size_t);
  void (*butterfly)(float *, float *, float *, float *, const float *,
                    const float *, size_t);
  void (*binary)(float *, const float *, const float *, size_t,
                 unsigned); /* add=0,multiply=1,divide=2 */
  void (*affine)(float *, const float *, float, float, size_t);
  void (*unary)(
      float *, const float *, size_t,
      unsigned); /* exp=0,erf=1,sigmoid=2,relu=3,negate=4,sqrt=5,log=6,log1p=7
                  */
  void (*complex_product)(float *, const float *, const float *, size_t,
                          unsigned); /* interleaved pairs; conjugate second */
  void (*phase)(ta_am_phase_state *);
  void (*window)(float *, const float *, const float *, size_t, size_t,
                 unsigned);
  void (*normalise)(float *, const float *, size_t, size_t);
  void (*crossfade_gain)(float *, float *, float, size_t, unsigned);
  double (*sum)(const float *, size_t, size_t);
  float (*maximum)(const float *, size_t, size_t);
  void (*clamp)(float *, const float *, float, float, size_t);
  double (*source_at)(double, float, float, size_t, double);
  float (*reduce)(const float *, size_t, size_t,
                  unsigned); /* float-order sum/squared sum */
  void (*moments)(const float *, size_t, double *,
                  float *); /* double energy, absolute peak */
  void (*lowpass_exit)(float *, size_t, unsigned, const float *, const float *);
  void (*downmix)(float *, const float *,
                  size_t); /* stereo mid, strongest channel for cancellation */
  void (*mix_frames)(const ta_am_frame_mix *);
  void (*headroom_envelope)(float *, size_t, unsigned);
} ta_am_kernels;
/* AUTO chooses AVX2 only with CPU AVX2 and OS XMM/YMM state support. Forced
 * unavailable paths fail. The returned table is immutable and process-owned. */
const ta_am_kernels *ta_am_get_kernels(ta_am_cpu cpu);
const char *ta_am_cpu_name(ta_am_cpu cpu);
void ta_am_c_axpy(float *, const float *, float, size_t);
float ta_am_c_dot(const float *, const float *, size_t);
void ta_am_c_gemm(const float *, const float *, float *, size_t, size_t,
                  size_t);
void ta_am_c_mix(float *, const float *, const float *, const float *,
                 const float *, size_t);
void ta_am_c_linear(float *, float, float, size_t);
void ta_am_c_butterfly(float *, float *, float *, float *, const float *,
                       const float *, size_t);
void ta_am_c_binary(float *, const float *, const float *, size_t, unsigned);
void ta_am_c_affine(float *, const float *, float, float, size_t);
void ta_am_c_unary(float *, const float *, size_t, unsigned);
/* In-place exp for normalized softmax scores in [-infinity, 0]; tails below
 * -87 become zero, NaN propagates. Relative error on [-87, 0] is < 1e-6. */
void ta_am_c_exp_negative(float *, size_t);
void ta_am_c_complex(float *, const float *, const float *, size_t, unsigned);
void ta_am_c_phase(ta_am_phase_state *);
void ta_am_c_window(float *, const float *, const float *, size_t, size_t,
                    unsigned);
void ta_am_c_normalise(float *, const float *, size_t, size_t);
void ta_am_c_crossfade_gain(float *, float *, float, size_t, unsigned);
double ta_am_c_sum(const float *, size_t, size_t);
float ta_am_c_maximum(const float *, size_t, size_t);
void ta_am_c_clamp(float *, const float *, float, float, size_t);
double ta_am_c_source_at(double, float, float, size_t, double);
float ta_am_c_reduce(const float *, size_t, size_t, unsigned);
void ta_am_c_moments(const float *, size_t, double *, float *);
void ta_am_c_lowpass_exit(float *, size_t, unsigned, const float *,
                          const float *);
void ta_am_c_downmix(float *, const float *, size_t);
void ta_am_c_mix_frames(const ta_am_frame_mix *);
void ta_am_c_headroom_envelope(float *, size_t, unsigned);
#ifdef __cplusplus
}
#endif
#endif
