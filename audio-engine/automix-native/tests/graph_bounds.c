#include "am_graph.h"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct {
  uint32_t rank, constant, d[8];
  uint64_t count, offset;
} tensor;
typedef struct {
  uint32_t op, ni, no, in[8], out[8];
  int32_t p[24];
  float f[4];
} node;
static void require(int ok, const char *label) {
  if (!ok) {
    fprintf(stderr, "FAIL %s\n", label);
    exit(1);
  }
}
static void fixture(unsigned which, const char *path) {
  uint32_t counts[4] = {3, 1, 1, 1}, io[2] = {0, 2};
  uint64_t sizes[3] = {32, 16, 16};
  tensor t[3] = {
      {2, 0, {2, 2}, 4, 0}, {2, 1, {2, 2}, 4, 0}, {2, 0, {2, 2}, 4, 16}};
  node n = {0};
  n.op = 13;
  n.ni = 2;
  n.no = 1;
  n.in[1] = 1;
  n.out[0] = 2;
  float weights[4] = {1, 2, 3, 4};
  switch (which) {
  case 1:
    n.ni = 3;
    n.in[2] = 0;
    break;
  case 2:
    n.op = 21;
    n.p[1] = 1;
    sizes[1] = 0;
    break;
  case 3:
    n.f[0] = NAN;
    break;
  case 4:
    t[2].constant = 1;
    t[2].offset = 0;
    break;
  case 5:
    t[2].d[1] = 3;
    break;
  case 6:
    t[0].offset = UINT64_MAX;
    break;
  case 7:
    t[0].rank = 9;
    break;
  case 8:
    io[0] = 1;
    break;
  case 9:
    n.op = 21;
    n.p[1] = 2;
    break;
  case 10:
    t[0].d[0] = UINT32_MAX;
    t[0].d[1] = UINT32_MAX;
    break;
  case 11:
    n.op = 10;
    n.ni = 1;
    n.f[0] = 1;
    n.f[1] = 0;
    break;
  case 12:
    t[0].d[0] = 0;
    t[0].count = 0;
    break;
  case 13:
    io[1] = 1;
    break;
  }
  FILE *f = fopen(path, "wb");
  require(f != NULL, "fixture file");
  fwrite("TAMG0001", 1, 8, f);
  fwrite(counts, 4, 4, f);
  fwrite(sizes, 8, 3, f);
  fwrite(t, sizeof(tensor), 3, f);
  fwrite(&n, sizeof(n), 1, f);
  fwrite(io, 4, 2, f);
  fwrite(weights, 4, 4, f);
  fclose(f);
}
static void attention(const ta_am_kernels *kernels, unsigned scratch_rows,
                        unsigned cols, float *previous) {
  const unsigned batches = 2, rows = 37, inner = 5, width = 9;
  const unsigned qcount = batches * rows * inner,
                 kcount = inner * cols, vcount = batches * cols * width,
                 outcount = batches * rows * width;
  uint32_t counts[4] = {4, 1, 1, 1}, io[2] = {0, 3};
  uint64_t sizes[3] = {(qcount + outcount) * 4, scratch_rows * cols * 4,
                        (kcount + vcount) * 4};
  tensor t[4] = {{3, 0, {batches, rows, inner}, qcount, 0},
                  {3, 1, {1, inner, cols}, kcount, 0},
                  {3, 1, {batches, cols, width}, vcount, kcount * 4},
                  {3, 0, {batches, rows, width}, outcount, qcount * 4}};
  node n = {0};
  n.op = 22; n.ni = 3; n.no = 1;
  n.in[1] = 1; n.in[2] = 2; n.out[0] = 3;
  float query[2 * 37 * 5], weights[5 * 13 + 2 * 13 * 9];
  for (unsigned i = 0; i < qcount; i++) query[i] = ((int)(i % 17) - 8) * .03f;
  for (unsigned i = 0; i < kcount + vcount; i++)
    weights[i] = ((int)(i % 19) - 9) * .07f;
  const char *path = "automix-attention-test.tamg";
  FILE *f = fopen(path, "wb");
  require(f != NULL, "attention fixture file");
  fwrite("TAMG0001", 1, 8, f);
  fwrite(counts, 4, 4, f); fwrite(sizes, 8, 3, f);
  fwrite(t, sizeof(tensor), 4, f); fwrite(&n, sizeof(n), 1, f);
  fwrite(io, 4, 2, f); fwrite(weights, 4, kcount + vcount, f);
  fclose(f);
  char error[128];
  ta_am_graph *g = ta_am_graph_load(path, kernels, error, sizeof(error));
  require(g != NULL, error);
  require(ta_am_graph_memory(g) == sizes[0] + sizes[1] + sizes[2],
          "attention keeps declared memory budget");
  require(!ta_am_graph_run(g, query, qcount, NULL), "attention run");
  const float *out = ta_am_graph_output(g, 0);
  for (unsigned b = 0; b < batches; b++)
    for (unsigned row = 0; row < rows; row++) {
      float score[13], maximum = -INFINITY;
      for (unsigned j = 0; j < cols; j++) {
        score[j] = 0;
        for (unsigned p = 0; p < inner; p++)
          score[j] += query[(b * rows + row) * inner + p] * weights[p * cols + j];
        maximum = fmaxf(maximum, score[j]);
      }
      double sum = 0;
      for (unsigned j = 0; j < cols; j++) {
        score[j] = expf(score[j] - maximum);
        sum += score[j];
      }
      if (cols)
        for (unsigned j = 0; j < cols; j++) score[j] *= (float)(1 / sum);
      for (unsigned d = 0; d < width; d++) {
        float expected = 0;
        for (unsigned j = 0; j < cols; j++)
          expected += score[j] * weights[kcount + (b * cols + j) * width + d];
        float actual = out[(b * rows + row) * width + d];
        require(isfinite(actual) && fabsf(actual - expected) < 2e-6f,
                "attention matches independent expf reference");
      }
    }
  if (cols && scratch_rows == 1)
    memcpy(previous, out, outcount * sizeof(float));
  else if (cols)
    require(!memcmp(previous, out, outcount * sizeof(float)),
            "attention batching keeps output bits across scratch sizes");
  ta_am_graph_free(g);
  remove(path);
}
int main(void) {
  const char *path = "automix-boundary-test.tamg";
  char error[128];
  for (unsigned i = 0; i < 14; i++) {
    fixture(i, path);
    ta_am_graph *g = ta_am_graph_load(path, ta_am_get_kernels(TA_AM_C), error,
                                      sizeof(error));
    if (i && g) {
      fprintf(stderr, "FAIL malformed graph case %u accepted\n", i);
      exit(1);
    } else if (!i) {
      require(g != NULL, error);
      float input[4] = {1, 1, 1, 1};
      ta_am_cancel *cancel = ta_am_cancel_create();
      require(cancel != NULL, "cancel token");
      ta_am_cancel_request(cancel);
      require(ta_am_graph_run(g, input, 4, cancel) == -2,
              "cancel before execution");
      require(!ta_am_graph_run(g, input, 4, NULL), "valid graph execution");
      const float *out = ta_am_graph_output(g, 0);
      require(out[0] == 4 && out[1] == 6 && out[2] == 4 && out[3] == 6,
              "matrix output");
      ta_am_cancel_free(cancel);
    }
    ta_am_graph_free(g);
  }
  remove(path);
  for (int cpu = TA_AM_C; cpu <= TA_AM_AVX2; cpu++) {
    const ta_am_kernels *kernels = ta_am_get_kernels((ta_am_cpu)cpu);
    if (kernels) {
      float previous[2 * 37 * 9];
      const unsigned scratch_rows[] = {1, 3, 8, 32, 64};
      for (unsigned i = 0; i < sizeof(scratch_rows) / sizeof(*scratch_rows); i++)
        attention(kernels, scratch_rows[i], 13, previous);
      attention(kernels, 0, 0, previous);
    }
  }
  puts("PASS graph scratch, rank, IO, params, matrix, bounded attention and cancellation");
  return 0;
}
