#include "am_graph.h"

#include <float.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "am_file.h"

enum {
  COPY = 1,
  TRANSPOSE,
  ADD,
  MUL,
  DIV,
  ERF,
  NEG,
  SIGMOID,
  RELU,
  CLIP,
  REDUCEL2,
  SOFTMAX,
  MATMUL,
  CONV,
  BN,
  EXPAND,
  SPLIT,
  SLICE,
  CONCAT,
  AVGPOOL,
  GEMM,
  ATTENTION
};
typedef struct {
  uint32_t rank, constant, d[8];
  uint64_t count, offset;
} tensor;
typedef struct {
  uint32_t op, ni, no, in[8], out[8];
  int32_t p[24];
  float f[4];
} node;
_Static_assert(sizeof(tensor) == 56, "fixed tensor ABI");
_Static_assert(sizeof(node) == 188, "fixed node ABI");
struct ta_am_graph {
  uint32_t nt, nn, ni, no, *io;
  uint64_t arena_size, scratch_size, weight_size;
  tensor *t;
  node *n;
  float *arena, *scratch, *weights;
  const ta_am_kernels *k;
  const ta_am_cancel *cancel;
};
static void message(char *dst, size_t n, const char *s) {
  if (dst && n)
    snprintf(dst, n, "%s", s);
}
static int read_exact(FILE *f, void *dst, size_t bytes) {
  return !bytes || fread(dst, 1, bytes, f) == bytes;
}
static float *data(ta_am_graph *g, unsigned id) {
  tensor *t = g->t + id;
  return (float *)((unsigned char *)(t->constant ? g->weights : g->arena) +
                   t->offset);
}
static size_t product(const tensor *t, unsigned start, unsigned end) {
  size_t p = 1;
  for (unsigned i = start; i < end; i++)
    p *= t->d[i];
  return p;
}
static size_t broadcast_index(const tensor *t, const tensor *out,
                              size_t index) {
  size_t off = 0, stride = 1;
  for (unsigned r = 0; r < t->rank; r++) {
    unsigned axis = t->rank - 1 - r, oa = out->rank - 1 - r;
    size_t pos = index % out->d[oa];
    index /= out->d[oa];
    if (t->d[axis] != 1)
      off += pos * stride;
    stride *= t->d[axis];
  }
  return off;
}
static int broadcasts(const tensor *t, const tensor *o) {
  if (t->rank > o->rank)
    return 0;
  for (unsigned i = 0; i < t->rank; i++)
    if (t->d[i] != 1 && t->d[i] != o->d[o->rank - t->rank + i])
      return 0;
  return 1;
}
static int same(const tensor *a, const tensor *b) {
  return a->rank == b->rank && !memcmp(a->d, b->d, a->rank * 4);
}
static int valid_node(ta_am_graph *g, const node *n) {
  if (n->op < COPY || n->op > ATTENTION || !n->ni || !n->no || n->ni > 8 ||
      n->no > 8)
    return 0;
  for (unsigned i = 0; i < 4; i++)
    if (!isfinite(n->f[i]))
      return 0;
  for (unsigned i = 0; i < n->ni; i++)
    if (n->in[i] >= g->nt)
      return 0;
  for (unsigned i = 0; i < n->no; i++)
    if (n->out[i] >= g->nt || g->t[n->out[i]].constant)
      return 0;
  const tensor *a = g->t + n->in[0], *o = g->t + n->out[0];
  if (n->op != SPLIT && n->no != 1)
    return 0;
  if (n->op == COPY)
    return n->ni == 1 && a->count == o->count;
  if (n->op == TRANSPOSE) {
    unsigned mask = 0;
    if (n->ni != 1 || a->rank != o->rank)
      return 0;
    for (unsigned i = 0; i < o->rank; i++) {
      int p = n->p[i];
      if (p < 0 || (unsigned)p >= a->rank || (mask & (1u << p)) ||
          o->d[i] != a->d[p])
        return 0;
      mask |= 1u << p;
    }
    return 1;
  }
  if (n->op >= ADD && n->op <= DIV)
    return n->ni == 2 && broadcasts(a, o) && broadcasts(g->t + n->in[1], o);
  if ((n->op >= ERF && n->op <= CLIP))
    return n->ni == 1 && same(a, o) && (n->op != CLIP || n->f[0] <= n->f[1]);
  if (n->op == EXPAND)
    return n->ni == 1 && broadcasts(a, o);
  if (n->op == REDUCEL2 || n->op == SOFTMAX) {
    int p = n->p[0];
    if (n->ni != 1 || p < 0 || (unsigned)p >= a->rank || a->rank != o->rank)
      return 0;
    for (unsigned i = 0; i < a->rank; i++)
      if (o->d[i] != (n->op == REDUCEL2 && i == (unsigned)p ? 1 : a->d[i]))
        return 0;
    return 1;
  }
  if (n->op == MATMUL || n->op == ATTENTION || n->op == GEMM) {
    if (n->ni < 2 || n->ni > 3 || a->rank < 2)
      return 0;
    if (n->op == MATMUL && n->ni != 2)
      return 0;
    const tensor *b = g->t + n->in[1];
    if (b->rank < 2 || o->rank < 2)
      return 0;
    size_t m = a->d[a->rank - 2], k = a->d[a->rank - 1],
           inner = b->d[b->rank - 2], cols = b->d[b->rank - 1];
    if (n->op == GEMM) {
      if (a->rank != 2 || b->rank != 2 || o->rank != 2 || n->p[0] ||
          (n->p[1] != 0 && n->p[1] != 1))
        return 0;
      if (n->p[1]) {
        inner = cols;
        cols = b->d[0];
        if (b->count > g->scratch_size / sizeof(float))
          return 0;
      }
      if (n->ni == 3 && !broadcasts(g->t + n->in[2], o))
        return 0;
    }
    if (k != inner)
      return 0;
    if (n->op == ATTENTION) {
      if (n->ni != 3)
        return 0;
      const tensor *v = g->t + n->in[2];
      if (v->rank < 2 || v->d[v->rank - 2] != cols ||
          g->scratch_size < cols * 4)
        return 0;
      cols = v->d[v->rank - 1];
    }
    if (o->d[o->rank - 2] != m || o->d[o->rank - 1] != cols)
      return 0;
    /* Batch dimensions must broadcast independently of the matrix axes. */
    tensor ab = *a, bb = *b, ob = *o;
    ab.rank -= 2;
    bb.rank -= 2;
    ob.rank -= 2;
    if (!broadcasts(&ab, &ob) || !broadcasts(&bb, &ob))
      return 0;
    if (n->op == ATTENTION) {
      tensor vb = g->t[n->in[2]];
      vb.rank -= 2;
      if (!broadcasts(&vb, &ob))
        return 0;
    }
    return 1;
  }
  if (n->op == CONV) {
    if ((n->ni != 2 && n->ni != 3) || a->rank != 4 || o->rank != 4)
      return 0;
    const tensor *w = g->t + n->in[1];
    int group = n->p[0];
    if (w->rank != 4 || group < 1 || a->d[1] != (uint64_t)w->d[1] * group ||
        w->d[0] % group || o->d[1] != w->d[0] || o->d[0] != a->d[0])
      return 0;
    if (n->ni == 3 && g->t[n->in[2]].count != w->d[0])
      return 0;
    for (unsigned axis = 0; axis < 2; axis++) {
      int stride = n->p[1 + axis], dilation = n->p[7 + axis];
      if (stride < 1 || dilation < 1 || n->p[3 + axis] < 0 ||
          n->p[5 + axis] < 0)
        return 0;
      int64_t length = (int64_t)a->d[2 + axis] + n->p[3 + axis] +
                       n->p[5 + axis] -
                       (int64_t)dilation * (w->d[2 + axis] - 1) - 1;
      if (length < 0 || (uint64_t)(length / stride + 1) != o->d[2 + axis])
        return 0;
    }
    return product(w, 1, 4) * product(o, 2, 4) * 4 <= g->scratch_size;
  }
  if (n->op == BN) {
    if (n->ni != 5 || a->rank < 2 || !same(a, o) || n->f[0] <= 0)
      return 0;
    for (unsigned i = 1; i < 5; i++)
      if (g->t[n->in[i]].count != a->d[1])
        return 0;
    return 1;
  }
  if (n->op == SPLIT || n->op == CONCAT) {
    int axis = n->p[0];
    if (axis < 0 || (unsigned)axis >= a->rank || o->rank != a->rank)
      return 0;
    size_t total = 0;
    unsigned count = n->op == SPLIT ? n->no : n->ni;
    for (unsigned j = 0; j < count; j++) {
      const tensor *t = g->t + (n->op == SPLIT ? n->out[j] : n->in[j]);
      const tensor *base = n->op == SPLIT ? a : o;
      if (t->rank != base->rank)
        return 0;
      for (unsigned i = 0; i < t->rank; i++)
        if (i != (unsigned)axis && t->d[i] != base->d[i])
          return 0;
      total += t->d[axis];
    }
    return total == (n->op == SPLIT ? a : o)->d[axis];
  }
  if (n->op == SLICE) {
    if (n->ni != 1 || a->rank != o->rank)
      return 0;
    for (unsigned i = 0; i < a->rank; i++) {
      if (!n->p[8 + i])
        return 0;
      if (!o->d[i])
        continue;
      int64_t end = n->p[i] + (int64_t)(o->d[i] - 1) * n->p[8 + i];
      if (n->p[i] < 0 || (uint32_t)n->p[i] >= a->d[i] || end < 0 ||
          (uint64_t)end >= a->d[i])
        return 0;
    }
    return 1;
  }
  if (n->op == AVGPOOL)
    return n->ni == 1 && a->rank == 4 && o->rank == 4 && a->d[0] == o->d[0] &&
           a->d[1] == o->d[1] && a->d[2] && a->d[3] && o->d[2] == 1 &&
           o->d[3] == 1;
  return 0;
}
ta_am_graph *ta_am_graph_load(const char *path, const ta_am_kernels *k,
                              char *err, size_t en) {
  message(err, en, "");
  if (!path || !k) {
    message(err, en, "invalid graph arguments");
    return NULL;
  }
  FILE *f = ta_am_open_read(path);
  if (!f) {
    message(err, en, "public model asset unavailable");
    return NULL;
  }
  ta_am_graph *g = calloc(1, sizeof(*g));
  char magic[8];
  const char *why = "invalid fixed graph";
  if (!g)
    goto fail;
  g->k = k;
  if (!read_exact(f, magic, 8) || memcmp(magic, "TAMG0001", 8) ||
      !read_exact(f, &g->nt, 4) || !read_exact(f, &g->nn, 4) ||
      !read_exact(f, &g->ni, 4) || !read_exact(f, &g->no, 4) ||
      !read_exact(f, &g->arena_size, 8) ||
      !read_exact(f, &g->scratch_size, 8) || !read_exact(f, &g->weight_size, 8))
    goto fail;
  if (!g->nt || g->nt > 8192 || !g->nn || g->nn > 4096 || g->ni != 1 ||
      !g->no || g->no > 8 || g->arena_size > 512ull * 1024 * 1024 ||
      g->scratch_size > 128ull * 1024 * 1024 ||
      g->weight_size > 128ull * 1024 * 1024 || g->arena_size % 4 ||
      g->scratch_size % 4 || g->weight_size % 4)
    goto fail;
  g->t = calloc(g->nt, sizeof(tensor));
  g->n = calloc(g->nn, sizeof(node));
  g->io = calloc(g->ni + g->no, 4);
  g->arena = calloc(1, (size_t)g->arena_size + 4);
  g->scratch = calloc(1, (size_t)g->scratch_size + 4);
  g->weights = malloc((size_t)g->weight_size + 4);
  if (!g->t || !g->n || !g->io || !g->arena || !g->scratch || !g->weights) {
    why = "analysis memory budget unavailable";
    goto fail;
  }
  if (!read_exact(f, g->t, g->nt * sizeof(tensor)) ||
      !read_exact(f, g->n, g->nn * sizeof(node)) ||
      !read_exact(f, g->io, (g->ni + g->no) * 4) ||
      !read_exact(f, g->weights, (size_t)g->weight_size) || fgetc(f) != EOF)
    goto fail;
  for (unsigned i = 0; i < g->nt; i++) {
    tensor *t = g->t + i;
    uint64_t count = 1, limit = t->constant ? g->weight_size : g->arena_size;
    if (t->rank > 8 || t->constant > 1 || t->offset % 4 || t->offset > limit)
      goto fail;
    for (unsigned j = 0; j < t->rank; j++) {
      if (t->d[j] > 1000000 || count > UINT64_MAX / (t->d[j] ? t->d[j] : 1))
        goto fail;
      count *= t->d[j];
    }
    if (count != t->count || count > (limit - t->offset) / 4)
      goto fail;
  }
  for (unsigned i = 0; i < g->ni + g->no; i++)
    /* Empty intermediate slices are legal (rotary attention uses them).
     * External model IO must be real, writable, nonempty tensors. */
    if (g->io[i] >= g->nt || g->t[g->io[i]].constant || !g->t[g->io[i]].count)
      goto fail;
  for (unsigned i = 0; i < g->nn; i++)
    if (!valid_node(g, g->n + i)) {
      why = "unsupported or invalid fixed operator";
      goto fail;
    }
  fclose(f);
  return g;
fail:
  fclose(f);
  ta_am_graph_free(g);
  message(err, en, why);
  return NULL;
}
void ta_am_graph_free(ta_am_graph *g) {
  if (g) {
    free(g->t);
    free(g->n);
    free(g->io);
    free(g->arena);
    free(g->scratch);
    free(g->weights);
    free(g);
  }
}
size_t ta_am_graph_memory(const ta_am_graph *g) {
  return g ? (size_t)(g->arena_size + g->scratch_size + g->weight_size) : 0;
}
size_t ta_am_graph_input_count(const ta_am_graph *g, unsigned i) {
  return g && i < g->ni ? (size_t)g->t[g->io[i]].count : 0;
}
size_t ta_am_graph_output_count(const ta_am_graph *g, unsigned i) {
  return g && i < g->no ? (size_t)g->t[g->io[g->ni + i]].count : 0;
}
const float *ta_am_graph_output(const ta_am_graph *g, unsigned i) {
  return g && i < g->no ? data((ta_am_graph *)g, g->io[g->ni + i]) : NULL;
}
static void softmax(ta_am_graph *g, float *x, size_t n) {
  float max = g->k->maximum(x, n, 1);
  g->k->affine(x, x, 1, -max, n);
  ta_am_c_exp_negative(x, n);
  double sum = g->k->sum(x, n, 1);
  g->k->affine(x, x, (float)(1 / sum), 0, n);
}
static size_t batch_offset(const tensor *a, const tensor *o, size_t batch) {
  tensor x = *a, y = *o;
  x.rank -= 2;
  y.rank -= 2;
  return broadcast_index(&x, &y, batch) * product(a, a->rank - 2, a->rank);
}
static void run_node(ta_am_graph *g, const node *n) {
  const tensor *a = g->t + n->in[0], *o = g->t + n->out[0];
  float *x = data(g, n->in[0]), *z = data(g, n->out[0]);
  size_t count = (size_t)o->count;
  if (n->op == COPY) {
    memcpy(z, x, count * 4);
    return;
  }
  if (n->op == TRANSPOSE || n->op == SLICE) {
    size_t stride[8], s = 1;
    for (unsigned i = a->rank; i-- > 0;) {
      stride[i] = s;
      s *= a->d[i];
    }
    for (size_t j = 0; j < count; j++) {
      size_t off = 0, index = j;
      for (unsigned i = o->rank; i-- > 0;) {
        size_t pos = index % o->d[i];
        index /= o->d[i];
        if (n->op == TRANSPOSE)
          off += pos * stride[n->p[i]];
        else
          off += (size_t)(n->p[i] + (int64_t)pos * n->p[8 + i]) * stride[i];
      }
      z[j] = x[off];
    }
    return;
  }
  if (n->op == EXPAND) {
    for (size_t j = 0; j < count; j++)
      z[j] = x[broadcast_index(a, o, j)];
    return;
  }
  if (n->op >= ADD && n->op <= DIV) {
    const tensor *b = g->t + n->in[1];
    float *y = data(g, n->in[1]);
    if (same(a, o) && same(b, o)) {
      g->k->binary(z, x, y, count, n->op - ADD);
      return;
    }
    if (same(a, o) && b->count == 1) {
      g->k->affine(z, x,
                   n->op == ADD   ? 1
                   : n->op == MUL ? y[0]
                                  : 1 / y[0],
                   n->op == ADD ? y[0] : 0, count);
      return;
    }
    if (same(a, o) && b->rank && b->count == b->d[b->rank - 1] &&
        b->d[b->rank - 1] == o->d[o->rank - 1]) {
      size_t width = b->d[b->rank - 1];
      for (size_t j = 0; j < count; j += width)
        g->k->binary(z + j, x + j, y, width, n->op - ADD);
      return;
    }
    for (size_t j = 0; j < count; j++) {
      g->k->binary(z + j, x + broadcast_index(a, o, j),
                   y + broadcast_index(b, o, j), 1, n->op - ADD);
    }
    return;
  }
  if (n->op >= ERF && n->op < CLIP) {
    unsigned unary = n->op == ERF       ? 1
                     : n->op == NEG     ? 4
                     : n->op == SIGMOID ? 2
                                        : 3;
    g->k->unary(z, x, count, unary);
    return;
  }
  if (n->op == CLIP) {
    g->k->clamp(z, x, n->f[0], n->f[1], count);
    return;
  }
  if (n->op == BN) {
    size_t inner = product(a, 2, a->rank);
    float *scale = data(g, n->in[1]), *bias = data(g, n->in[2]),
          *mean = data(g, n->in[3]), *variance = data(g, n->in[4]);
    for (size_t j = 0; j < count; j += inner) {
      size_t c = (j / inner) % a->d[1];
      float root, gain, offset;
      g->k->binary(&root, variance + c, n->f, 1, 0);
      g->k->unary(&root, &root, 1, 5);
      g->k->binary(&gain, scale + c, &root, 1, 2);
      g->k->affine(&offset, mean + c, -gain, bias[c], 1);
      g->k->affine(z + j, x + j, gain, offset, inner);
    }
    return;
  }
  if (n->op == REDUCEL2 || n->op == SOFTMAX) {
    unsigned axis = (unsigned)n->p[0];
    size_t inner = product(a, axis + 1, a->rank), width = a->d[axis],
           outer = product(a, 0, axis);
    if (n->op == SOFTMAX)
      memcpy(z, x, count * 4);
    for (size_t row = 0; row < outer; row++)
      for (size_t j = 0; j < inner; j++) {
        if (n->op == REDUCEL2) {
          float sum =
              g->k->reduce(x + row * width * inner + j, width, inner, 1);
          g->k->unary(z + row * inner + j, &sum, 1, 5);
        } else if (inner == 1)
          softmax(g, z + row * width, width);
        else {
          float max = g->k->maximum(x + row * width * inner + j, width, inner);
          for (size_t t = 0; t < width; t++) {
            size_t p = (row * width + t) * inner + j;
            g->k->affine(z + p, x + p, 1, -max, 1);
            g->k->unary(z + p, z + p, 1, 0);
          }
          float sum =
              (float)g->k->sum(z + row * width * inner + j, width, inner);
          for (size_t t = 0; t < width; t++) {
            size_t p = (row * width + t) * inner + j;
            g->k->binary(z + p, z + p, &sum, 1, 2);
          }
        }
      }
    return;
  }
  if (n->op == MATMUL || n->op == ATTENTION || n->op == GEMM) {
    const tensor *b = g->t + n->in[1];
    float *y = data(g, n->in[1]);
    size_t m = a->d[a->rank - 2], k = a->d[a->rank - 1],
           cols = b->d[b->rank - 1], batches = product(o, 0, o->rank - 2);
    if (n->op == GEMM && n->p[1]) {
      cols = b->d[0];
      for (size_t i = 0; i < k; i++)
        for (size_t j = 0; j < cols; j++)
          g->scratch[i * cols + j] = y[j * k + i];
      y = g->scratch;
    }
    for (size_t batch = 0; batch < batches; batch++) {
      const float *u = x + batch_offset(a, o, batch),
                  *v = y + batch_offset(b, o, batch);
      if (n->op == ATTENTION) {
        const tensor *vt = g->t + n->in[2];
        size_t d = vt->d[vt->rank - 1];
        const float *values = data(g, n->in[2]) + batch_offset(vt, o, batch);
        /* Reuse the graph's existing scratch budget, never a quadratic score
         * tensor. Batching queries lets GEMM reuse keys/values across rows. */
        size_t block = cols ? g->scratch_size / (cols * sizeof(float)) : 32;
        if (block > 32)
          block = 32;
        for (size_t row = 0; row < m; row += block) {
          if (ta_am_cancelled(g->cancel))
            return;
          size_t rows = m - row < block ? m - row : block;
          g->k->gemm(u + row * k, v, g->scratch, rows, k, cols);
          for (size_t q = 0; q < rows; q++)
            softmax(g, g->scratch + q * cols, cols);
          g->k->gemm(g->scratch, values, z + (batch * m + row) * d,
                       rows, cols, d);
        }
      } else
        g->k->gemm(u, v, z + batch * m * cols, m, k, cols);
    }
    if (n->op == GEMM) {
      float *bias = n->ni == 3 ? data(g, n->in[2]) : NULL;
      g->k->affine(z, z, n->f[0], 0, count);
      if (bias)
        for (size_t i = 0; i < count; i++) {
          float value;
          g->k->affine(&value, bias + broadcast_index(g->t + n->in[2], o, i),
                       n->f[1], 0, 1);
          g->k->binary(z + i, z + i, &value, 1, 0);
        }
    }
    return;
  }
  if (n->op == CONV) {
    const tensor *w = g->t + n->in[1];
    float *weights = data(g, n->in[1]),
          *bias = n->ni == 3 ? data(g, n->in[2]) : NULL;
    size_t cin = w->d[1], kh = w->d[2], kw = w->d[3], h = a->d[2],
           width = a->d[3], oh = o->d[2], ow = o->d[3], pixels = oh * ow,
           k = cin * kh * kw, cout = w->d[0] / n->p[0];
    for (size_t batch = 0; batch < a->d[0]; batch++)
      for (int group = 0; group < n->p[0]; group++) {
        for (size_t c = 0; c < cin; c++)
          for (size_t fy = 0; fy < kh; fy++)
            for (size_t fx = 0; fx < kw; fx++)
              for (size_t ry = 0; ry < oh; ry++)
                for (size_t rx = 0; rx < ow; rx++) {
                  int64_t iy = (int64_t)ry * n->p[1] - n->p[3] + fy * n->p[7],
                          ix = (int64_t)rx * n->p[2] - n->p[4] + fx * n->p[8];
                  size_t p = ((c * kh + fy) * kw + fx) * pixels + ry * ow + rx;
                  g->scratch[p] =
                      (iy < 0 || ix < 0 || (uint64_t)iy >= h ||
                       (uint64_t)ix >= width)
                          ? 0
                          : x[((batch * a->d[1] + group * cin + c) * h +
                               (size_t)iy) *
                                  width +
                              (size_t)ix];
                }
        float *dst = z + (batch * o->d[1] + group * cout) * pixels;
        g->k->gemm(weights + group * cout * k, g->scratch, dst, cout, k,
                   pixels);
        if (bias)
          for (size_t c = 0; c < cout; c++)
            g->k->affine(dst + c * pixels, dst + c * pixels, 1,
                         bias[group * cout + c], pixels);
      }
    return;
  }
  if (n->op == SPLIT || n->op == CONCAT) {
    unsigned axis = (unsigned)n->p[0];
    size_t inner = product(a, axis + 1, a->rank), outer = product(a, 0, axis),
           offset = 0;
    unsigned parts = n->op == SPLIT ? n->no : n->ni;
    for (unsigned j = 0; j < parts; j++) {
      const tensor *t = g->t + (n->op == SPLIT ? n->out[j] : n->in[j]);
      float *v = data(g, n->op == SPLIT ? n->out[j] : n->in[j]);
      size_t span = t->d[axis] * inner;
      for (size_t row = 0; row < outer; row++)
        if (n->op == SPLIT)
          memcpy(v + row * span, x + row * a->d[axis] * inner + offset,
                 span * 4);
        else
          memcpy(z + row * o->d[axis] * inner + offset, v + row * span,
                 span * 4);
      offset += span;
    }
    return;
  }
  if (n->op == AVGPOOL) {
    size_t width = product(a, 2, 4);
    for (size_t i = 0; i < count; i++) {
      float sum = g->k->reduce(x + i * width, width, 1, 0),
            divisor = (float)width;
      g->k->binary(z + i, &sum, &divisor, 1, 2);
    }
  }
}
int ta_am_graph_run(ta_am_graph *g, const float *input, size_t count,
                    const ta_am_cancel *cancel) {
  if (!g || !input || count != ta_am_graph_input_count(g, 0))
    return -1;
  for (size_t i = 0; i < count; i++)
    if (!isfinite(input[i]))
      return -1;
  g->cancel = cancel;
  memcpy(data(g, g->io[0]), input, count * 4);
  for (unsigned i = 0; i < g->nn; i++) {
    if (ta_am_cancelled(cancel))
      return -2;
    run_node(g, g->n + i);
  }
  if (ta_am_cancelled(cancel))
    return -2;
  for (unsigned i = 0; i < g->no; i++) {
    const float *x = ta_am_graph_output(g, i);
    for (size_t j = 0; j < ta_am_graph_output_count(g, i); j++)
      if (!isfinite(x[j]))
        return -3;
  }
  return 0;
}
