#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "am_fft.h"
#include "am_kernels.h"

static unsigned seed = 17;
static float random_sample(void) {
  seed = seed * 1664525u + 1013904223u;
  return ((seed >> 8) / 16777216.0f - 0.5f) * 2;
}
static void check(int ok, const char *label) {
  if (!ok) {
    fprintf(stderr, "FAIL: %s\n", label);
    exit(1);
  }
}
static void equal(const float *a, const float *b, size_t n, float tol,
                  const char *label) {
  for (size_t i = 0; i < n; i++)
    if (!isfinite(a[i]) || !isfinite(b[i]) ||
        fabsf(a[i] - b[i]) > tol * (1 + fabsf(a[i]))) {
      fprintf(stderr, "%s[%zu]: %.9g vs %.9g\n", label, i, a[i], b[i]);
      exit(1);
    }
}
static void reference_gemm(const float *a, const float *b, float *c,
                            size_t m, size_t k, size_t n) {
  for (size_t i = 0; i < m; i++)
    for (size_t j = 0; j < n; j++) {
      float sum = 0;
      for (size_t p = 0; p < k; p++)
        sum += a[i * k + p] * b[p * n + j];
      c[i * n + j] = sum;
    }
}
static void gemm_tiles(const ta_am_kernels *kernels) {
  const size_t shapes[][3] = {
      {3, 31, 7}, {4, 32, 8}, {5, 33, 9}, {7, 127, 15},
      {8, 128, 16}, {9, 129, 17}, {31, 32, 33}, {32, 32, 1500},
      {33, 1500, 32}, {35, 0, 35}, {4, 128, 0}};
  for (size_t s = 0; s < sizeof(shapes) / sizeof(*shapes); s++) {
    size_t m = shapes[s][0], k = shapes[s][1], n = shapes[s][2], count = m * n;
    float *a = malloc((m * k + 1) * sizeof(float)),
          *b = malloc((k * n + 1) * sizeof(float)),
          *expected = calloc(count + 2, sizeof(float)),
          *actual = calloc(count + 2, sizeof(float));
    check(a && b && expected && actual, "tile test buffers");
    for (size_t i = 0; i < m * k + 1; i++) a[i] = random_sample();
    for (size_t i = 0; i < k * n + 1; i++) b[i] = random_sample();
    actual[0] = actual[count + 1] = 123.5f;
    reference_gemm(a + 1, b + 1, expected + 1, m, k, n);
    kernels->gemm(a + 1, b + 1, actual + 1, m, k, n);
    equal(expected + 1, actual + 1, count,
          kernels->cpu == TA_AM_C ? 0 : 4e-5f, "GEMM tile and long reduction");
    if (kernels->cpu == TA_AM_C)
      check(!memcmp(expected + 1, actual + 1, count * sizeof(float)),
            "C GEMM preserves accumulation bits");
    check(actual[0] == 123.5f && actual[count + 1] == 123.5f, "GEMM tile bounds");
    free(a); free(b); free(expected); free(actual);
  }
}
static void softmax_exponential(void) {
  float maximum = 0;
  for (unsigned batch = 0; batch < 87; batch++) {
    float input[1001], actual[1001];
    for (unsigned i = 0; i <= 1000; i++)
      input[i] = actual[i] = -(float)batch - (float)i / 1000;
    ta_am_c_exp_negative(actual, 1001);
    for (unsigned i = 0; i <= 1000; i++) {
      float expected = expf(input[i]);
      float relative = fabsf(actual[i] - expected) / expected;
      maximum = fmaxf(maximum, relative);
      check(relative < 1e-6f, "normalized exponential relative error");
    }
  }
  float special[] = {0, -INFINITY, -88, NAN};
  ta_am_c_exp_negative(special, 4);
  check(special[0] == 1 && special[1] == 0 && special[2] == 0 && isnan(special[3]),
        "normalized exponential endpoints");
  printf("PASS softmax exp: 87087 values, maximum relative error %.9g\n", maximum);
}
static void differential(const ta_am_kernels *k) {
  float a[2048], b[2048], ga[2048], gb[2048], c[2048], d[2048];
  for (size_t i = 0; i < 2048; i++) {
    a[i] = random_sample();
    b[i] = random_sample();
    ga[i] = random_sample();
    gb[i] = random_sample();
  }
  const size_t sizes[] = {0, 1,  2,  3,  4,   5,    7,   8,
                          9, 15, 16, 17, 127, 1023, 2048};
  for (size_t j = 0; j < sizeof(sizes) / sizeof(*sizes); j++) {
    size_t n = sizes[j];
    memcpy(c, a, sizeof(a));
    memcpy(d, a, sizeof(a));
    ta_am_c_axpy(c, b, 0.317f, n);
    k->axpy(d, b, 0.317f, n);
    equal(c, d, 2048, 1e-6f, "axpy");
    float ref = ta_am_c_dot(a, b, n), got = k->dot(a, b, n);
    equal(&ref, &got, 1, 4e-5f, "correlation");
    memset(c, 0, sizeof(c));
    memset(d, 0, sizeof(d));
    ta_am_c_mix(c, a, b, ga, gb, n);
    k->mix(d, a, b, ga, gb, n);
    equal(c, d, 2048, 1e-6f, "mix");
    memcpy(c, a, sizeof(c));
    memcpy(d, a, sizeof(d));
    ta_am_c_mix(c, c, b, ga, gb, n);
    k->mix(d, d, b, ga, gb, n);
    equal(c, d, 2048, 1e-6f, "mix alias");
    ta_am_c_linear(c, 0.37f, -1.1f, n);
    k->linear(d, 0.37f, -1.1f, n);
    equal(c, d, 2048, 1e-6f, "gain curve");
    for (unsigned op = 0; op < 3; op++) {
      ta_am_c_binary(c, a, b, n, op);
      k->binary(d, a, b, n, op);
      equal(c, d, n, 1e-6f, "binary");
    }
    ta_am_c_affine(c, a, 0.51f, 0.1f, n);
    k->affine(d, a, 0.51f, 0.1f, n);
    equal(c, d, n, 1e-6f, "affine");
    /* erf uses the documented 5-term float approximation (< 1e-6 abs).
     * Model-level logits/events are checked separately against the oracle. */
    for (unsigned op = 0; op < 5; op++) {
      ta_am_c_unary(c, a, n, op);
      k->unary(d, a, n, op);
      equal(c, d, n, 1e-6f, "activation");
    }
    for (unsigned op = 0; op < 2; op++) {
      size_t pairs = n / 2;
      ta_am_c_complex(c, a, b, pairs, op);
      k->complex_product(d, a, b, pairs, op);
      equal(c, d, pairs * 2, 1e-6f, "complex product");
    }
  }
  for (size_t m = 0; m < 8; m++)
    for (size_t inner = 0; inner < 19; inner++)
      for (size_t n = 0; n < 19; n++) {
        memset(c, 0x55, sizeof(c));
        memset(d, 0x55, sizeof(d));
        reference_gemm(a, b, c, m, inner, n);
        k->gemm(a, b, d, m, inner, n);
        equal(c, d, m * n, 2e-6f, "gemm");
        check(memcmp(c + m * n, d + m * n, (2048 - m * n) * sizeof(float)) == 0,
              "gemm bounds");
      }
  gemm_tiles(k);
  for (size_t stride = 1; stride <= 8; stride++)
    for (size_t n = 0; n < 130; n++) {
      memcpy(c, a, sizeof(c));
      memcpy(d, a, sizeof(d));
      ta_am_c_window(c, b, ga, n, stride, 0);
      k->window(d, b, ga, n, stride, 0);
      equal(c, d, 2048, 1e-6f, "window gather and bounds");
      memcpy(c, a, sizeof(c));
      memcpy(d, a, sizeof(d));
      ta_am_c_window(c, b, ga, n, stride, 1);
      k->window(d, b, ga, n, stride, 1);
      equal(c, d, 2048, 1e-6f, "window overlap and bounds");
      memcpy(c, a, sizeof(c));
      memcpy(d, a, sizeof(d));
      ta_am_c_normalise(c, ga, n, stride);
      k->normalise(d, ga, n, stride);
      equal(c, d, 2048, 1e-6f, "normalisation floor and stride");
      check(ta_am_c_sum(a, n, stride) == k->sum(a, n, stride),
            "double reduction order");
      check(ta_am_c_maximum(a, n, stride) == k->maximum(a, n, stride),
            "strided maximum");
      for (unsigned square = 0; square < 2; square++)
        check(ta_am_c_reduce(a, n, stride, square) ==
                  k->reduce(a, n, stride, square),
              "float reduction order and stride");
    }
  for (size_t n = 0; n < 257; n++)
    for (unsigned channels = 1; channels <= 8; channels++) {
      ta_am_c_crossfade_gain(c, ga, 1.73f, n, channels);
      k->crossfade_gain(d, gb, 1.73f, n, channels);
      equal(c, d, n * channels, 2e-6f, "equal power outgoing");
      equal(ga, gb, n * channels, 2e-6f, "equal power incoming");
    }
  for (size_t n = 0; n < 240; n += 13)
    for (unsigned channels = 1; channels <= 8; channels++)
      for (unsigned stride = 1; stride <= 8; stride++) {
        memcpy(c, a, sizeof(c));
        memcpy(d, a, sizeof(d));
        ta_am_frame_mix ref = {c, a, b, ga, gb, n, channels, stride},
                        actual = ref;
        actual.destination = d;
        ta_am_c_mix_frames(&ref);
        k->mix_frames(&actual);
        equal(c, d, 2048, 0, "routed frame mix, gain stride and bounds");
        memcpy(c, a, sizeof(c));
        memcpy(d, a, sizeof(d));
        ref.destination = c;
        ref.current = c;
        actual.destination = d;
        actual.current = d;
        ta_am_c_mix_frames(&ref);
        k->mix_frames(&actual);
        equal(c, d, 2048, 0, "routed mix alias");
      }
  for (size_t n = 0; n < 2048; n += 13) {
    double energyC, energyAsm;
    float peakC, peakAsm;
    ta_am_c_moments(a, n, &energyC, &peakC);
    k->moments(a, n, &energyAsm, &peakAsm);
    check(energyC == energyAsm && peakC == peakAsm,
          "double PCM energy and peak");
  }
  for (unsigned fixture = 0; fixture < 4; fixture++) {
    for (size_t i = 0; i < 1024; i++) {
      a[2 * i] = random_sample();
      a[2 * i + 1] = fixture == 0   ? random_sample()
                     : fixture == 1 ? -a[2 * i]
                     : fixture == 2 ? -a[2 * i] * 1.03f
                                    : a[2 * i];
    }
    for (size_t n = 0; n <= 1024; n += 16) {
      memcpy(c, b, sizeof(c));
      memcpy(d, b, sizeof(d));
      ta_am_c_downmix(c, a, n);
      k->downmix(d, a, n);
      equal(c, d, 2048, 0, "stereo downmix, anti-phase and bounds");
    }
  }
  for (size_t n = 0; n < 257; n += 7)
    for (unsigned channels = 1; channels <= 8; channels++) {
      for (size_t i = 0; i < n; i++) {
        ga[i] = fabsf(random_sample());
        gb[i] = fabsf(random_sample());
      }
      memcpy(c, a, sizeof(c));
      memcpy(d, a, sizeof(d));
      ta_am_c_lowpass_exit(c, n, channels, ga, gb);
      k->lowpass_exit(d, n, channels, ga, gb);
      equal(c, d, 2048, 0, "filter state, channels and bounds");
    }
  for (size_t i = 0; i < 2048; i++)
    b[i] = powf(10, ((float)i / 2047) * 76 - 38);
  for (unsigned op = 5; op <= 7; op++) {
    ta_am_c_unary(c, b, 2048, op);
    k->unary(d, b, 2048, op);
    equal(c, d, 2048, 1e-6f, "sqrt/log/log1p domain");
  }
  ta_am_c_clamp(c, a, -0.17f, 0.51f, 2048);
  k->clamp(d, a, -0.17f, 0.51f, 2048);
  equal(c, d, 2048, 0, "clamp");
  for (size_t n = 0; n < 2048; n += 31) {
    for (unsigned rate_index = 0; rate_index < 3; rate_index++) {
      unsigned rate = rate_index == 0 ? 8000 : rate_index == 1 ? 48000 : 384000;
      for (size_t i = 0; i < 2048; i++) c[i] = d[i] = fabsf(a[i]);
      ta_am_c_headroom_envelope(c, n, rate);
      k->headroom_envelope(d, n, rate);
      equal(c, d, 2048, 0, "headroom attack, release, boundaries and array tails");
      if (n) check(c[0] == 1 && c[n - 1] == 1, "headroom preserves source joins");
    }
  }
  for (size_t frames = 0; frames < 10000; frames += 37)
    for (unsigned j = 0; j < 12; j++) {
      double output = frames * j / 10.0;
      double expected =
                 ta_am_c_source_at(1234567.3, 0.93f, 1.02f, frames, output),
             actual = k->source_at(1234567.3, 0.93f, 1.02f, frames, output);
      check(fabs(expected - actual) < 1e-8, "source mapping double integral");
      check(llround(expected) == llround(actual), "source frame boundary");
    }
  for (unsigned channels = 1; channels <= 8; channels++)
    for (size_t bins = 5; bins <= 129; bins += 31) {
      ta_am_complex input[1032], previous[1032], rotation[129], outC[1032],
          outAsm[1032];
      float eC[1032], eAsm[1032], ePrevious[1032];
      size_t count = channels * bins;
      for (size_t i = 0; i < count; i++) {
        float scale = i % 7 == 0 ? 1e-10f : 1;
        input[i] =
            (ta_am_complex){random_sample() * scale, random_sample() * scale};
        previous[i] =
            (ta_am_complex){random_sample() * scale, random_sample() * scale};
        outC[i] = outAsm[i] =
            (ta_am_complex){random_sample() * scale, random_sample() * scale};
        ePrevious[i] =
            previous[i].r * previous[i].r + previous[i].i * previous[i].i;
      }
      for (size_t i = 0; i < bins; i++)
        rotation[i] = (ta_am_complex){cosf((float)i), sinf((float)i)};
      for (unsigned pass = 0; pass < 6; pass++) {
        ta_am_phase_state ref = {
            bins,     channels, 4,        0.91f + pass * 0.04f,
            0,        input,    previous, outC,
            rotation, eC,       ePrevious};
        ta_am_phase_state native = ref;
        native.output = outAsm;
        native.energies = eAsm;
        ta_am_c_phase(&ref);
        k->phase(&native);
        equal((float *)outC, (float *)outAsm, count * 2, 2e-6f,
              "multi-channel phase transport");
        equal(eC, eAsm, count, 0, "phase energy");
      }
    }
  for (size_t n = 2; n <= 2048; n *= 2) {
    ta_am_fft *ref = ta_am_fft_create(n, ta_am_get_kernels(TA_AM_C));
    ta_am_fft *test = ta_am_fft_create(n, k);
    check(ref && test, "FFT create");
    memcpy(c, a, n * sizeof(float));
    memcpy(d, a, n * sizeof(float));
    float q[2048] = {0}, t[2048] = {0};
    check(!ta_am_fft_transform(ref, c, q, 0) &&
              !ta_am_fft_transform(test, d, t, 0),
          "FFT transform");
    equal(c, d, n, 2e-5f, "FFT real");
    equal(q, t, n, 2e-5f, "FFT imaginary");
    check(!ta_am_fft_transform(test, d, t, 1), "FFT inverse");
    equal(a, d, n, 2e-5f, "FFT round trip");
    memset(d, 0, n * sizeof(float));
    memset(t, 0, n * sizeof(float));
    d[0] = 1;
    check(!ta_am_fft_transform(test, d, t, 0), "impulse");
    for (size_t i = 0; i < n; i++)
      check(fabsf(d[i] - 1) < 1e-6f && fabsf(t[i]) < 1e-6f, "impulse spectrum");
    ta_am_fft_free(ref);
    ta_am_fft_free(test);
  }
  printf("PASS %s: tails, alias, GEMM, correlation, curves, FFT\n",
         ta_am_cpu_name(k->cpu));
}
int main(void) {
  softmax_exponential();
  check(ta_am_get_kernels((ta_am_cpu)99) == NULL, "invalid CPU rejected");
  check(ta_am_fft_create(3, ta_am_get_kernels(TA_AM_C)) == NULL,
        "invalid FFT rejected");
  for (int cpu = TA_AM_C; cpu <= TA_AM_AVX2; cpu++) {
    const ta_am_kernels *k = ta_am_get_kernels((ta_am_cpu)cpu);
    if (k)
      differential(k);
    else
      printf("SKIP %s (not available)\n", ta_am_cpu_name((ta_am_cpu)cpu));
  }
  return 0;
}
