#include "am_hash.h"
#if defined(_WIN32)
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "am_file.h"
typedef struct {
  uint32_t state[8];
  uint64_t count;
  unsigned used;
  unsigned char block[64];
} sha256;
static uint32_t rotate(uint32_t x, unsigned n) {
  return x >> n | x << (32 - n);
}
static void transform(sha256 *s) {
  static const uint32_t k[64] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  uint32_t w[64];
  for (unsigned i = 0; i < 16; i++)
    w[i] = (uint32_t)s->block[4 * i] << 24 |
           (uint32_t)s->block[4 * i + 1] << 16 |
           (uint32_t)s->block[4 * i + 2] << 8 | s->block[4 * i + 3];
  for (unsigned i = 16; i < 64; i++)
    w[i] = w[i - 16] +
           (rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >> 3)) +
           w[i - 7] +
           (rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >> 10));
  uint32_t a = s->state[0], b = s->state[1], c = s->state[2], d = s->state[3],
           e = s->state[4], f = s->state[5], g = s->state[6], h = s->state[7];
  for (unsigned i = 0; i < 64; i++) {
    uint32_t t1 = h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
                  ((e & f) ^ (~e & g)) + k[i] + w[i];
    uint32_t t2 = (rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
                  ((a & b) ^ (a & c) ^ (b & c));
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  uint32_t values[8] = {a, b, c, d, e, f, g, h};
  for (unsigned i = 0; i < 8; i++)
    s->state[i] += values[i];
}
static sha256 initialise(void) {
  sha256 s = {0};
  const uint32_t state[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                             0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  memcpy(s.state, state, sizeof(state));
  return s;
}
static void update(sha256 *s, const unsigned char *x, size_t n) {
  s->count += n;
  while (n) {
    size_t part = 64 - s->used;
    if (part > n)
      part = n;
    memcpy(s->block + s->used, x, part);
    s->used += (unsigned)part;
    x += part;
    n -= part;
    if (s->used == 64) {
      transform(s);
      s->used = 0;
    }
  }
}
static void finish(sha256 *s, char hex[65]) {
  uint64_t bits = s->count * 8;
  unsigned char one = 0x80, zero = 0;
  update(s, &one, 1);
  while (s->used != 56)
    update(s, &zero, 1);
  unsigned char length[8];
  for (unsigned i = 0; i < 8; i++)
    length[i] = (unsigned char)(bits >> (56 - i * 8));
  update(s, length, 8);
  static const char chars[] = "0123456789abcdef";
  for (unsigned i = 0; i < 32; i++) {
    unsigned byte = (s->state[i / 4] >> (24 - 8 * (i % 4))) & 255;
    hex[2 * i] = chars[byte >> 4];
    hex[2 * i + 1] = chars[byte & 15];
  }
  hex[64] = 0;
}
void ta_am_sha256(const void *bytes, size_t n, char hex[65]) {
  sha256 s = initialise();
  update(&s, bytes, n);
  finish(&s, hex);
}
int ta_am_sha256_file(const char *path, char hex[65]) {
  FILE *f = ta_am_open_read(path);
  if (!f)
    return -1;
  sha256 s = initialise();
  unsigned char buffer[32768];
  size_t count;
  while ((count = fread(buffer, 1, sizeof(buffer), f)))
    update(&s, buffer, count);
  int fail = ferror(f);
  fclose(f);
  if (fail)
    return -1;
  finish(&s, hex);
  return 0;
}
int ta_am_source_stamp_equal(const ta_am_source_stamp *a,
                             const ta_am_source_stamp *b) {
  return a && b && a->size == b->size && a->modified == b->modified &&
         a->created == b->created && a->file_index == b->file_index &&
         a->volume == b->volume;
}
#if defined(_WIN32)
struct ta_am_source_lease {
  HANDLE file;
  ta_am_source_stamp stamp;
};
static HANDLE source_open(const char *path, DWORD access, DWORD share) {
  if (!path || !path[0])
    return INVALID_HANDLE_VALUE;
  int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, NULL, 0);
  if (!n)
    return INVALID_HANDLE_VALUE;
  wchar_t *w = malloc((size_t)n * sizeof(wchar_t));
  if (!w)
    return INVALID_HANDLE_VALUE;
  MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, w, n);
  HANDLE h = CreateFileW(w, access, share, NULL, OPEN_EXISTING,
                         FILE_ATTRIBUTE_NORMAL, NULL);
  free(w);
  return h;
}
static int stamp(HANDLE h, ta_am_source_stamp *s) {
  BY_HANDLE_FILE_INFORMATION f;
  if (!GetFileInformationByHandle(h, &f) ||
      (f.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY))
    return 0;
  *s =
      (ta_am_source_stamp){((uint64_t)f.nFileSizeHigh << 32) | f.nFileSizeLow,
                           ((uint64_t)f.ftLastWriteTime.dwHighDateTime << 32) |
                               f.ftLastWriteTime.dwLowDateTime,
                           ((uint64_t)f.ftCreationTime.dwHighDateTime << 32) |
                               f.ftCreationTime.dwLowDateTime,
                           ((uint64_t)f.nFileIndexHigh << 32) | f.nFileIndexLow,
                           f.dwVolumeSerialNumber};
  return 1;
}
int ta_am_source_snapshot(const char *path, ta_am_source_stamp *s) {
  if (!s)
    return 0;
  HANDLE h =
      source_open(path, FILE_READ_ATTRIBUTES,
                  FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  if (h == INVALID_HANDLE_VALUE)
    return 0;
  int ok = stamp(h, s);
  CloseHandle(h);
  return ok;
}
ta_am_source_lease *ta_am_source_acquire(const char *path,
                                         const ta_am_source_stamp *expected,
                                         const char hash[65],
                                         const ta_am_cancel *cancel) {
  HANDLE h = source_open(path, GENERIC_READ, FILE_SHARE_READ);
  if (h == INVALID_HANDLE_VALUE)
    return NULL;
  ta_am_source_stamp actual;
  if (!stamp(h, &actual) || !ta_am_source_stamp_equal(expected, &actual))
    goto fail;
  sha256 digest = initialise();
  unsigned char buffer[32768];
  DWORD got;
  for (;;) {
    if (ta_am_cancelled(cancel) ||
        !ReadFile(h, buffer, sizeof(buffer), &got, NULL))
      goto fail;
    if (!got)
      break;
    update(&digest, buffer, got);
  }
  char hex[65];
  finish(&digest, hex);
  if (!hash || strcmp(hash, hex) || ta_am_cancelled(cancel))
    goto fail;
  ta_am_source_lease *lease = malloc(sizeof(*lease));
  if (!lease)
    goto fail;
  lease->file = h;
  lease->stamp = actual;
  return lease;
fail:
  CloseHandle(h);
  return NULL;
}
void ta_am_source_release(ta_am_source_lease *s) {
  if (s) {
    CloseHandle(s->file);
    free(s);
  }
}
int ta_am_source_valid(const ta_am_source_lease *s) {
  ta_am_source_stamp actual;
  return s && stamp(s->file, &actual) && ta_am_source_stamp_equal(&actual, &s->stamp);
}
int ta_am_source_snapshot_fd(int fd, ta_am_source_stamp *s) { (void)fd; (void)s; return 0; }
int ta_am_source_sha256_fd(int fd, char hex[65], const ta_am_cancel *c) { (void)fd; (void)hex; (void)c; return 0; }
ta_am_source_lease *ta_am_source_acquire_fd(int fd, const ta_am_source_stamp *s,
    const char h[65], const ta_am_cancel *c) { (void)fd; (void)s; (void)h; (void)c; return NULL; }
#else
struct ta_am_source_lease { int file; ta_am_source_stamp stamp; };
static int stamp(int fd, ta_am_source_stamp *s) {
  struct stat f;
  if (fstat(fd, &f) || !S_ISREG(f.st_mode) || f.st_size < 0) return 0;
#if defined(__APPLE__)
  const struct timespec m = f.st_mtimespec, c = f.st_ctimespec;
#else
  const struct timespec m = f.st_mtim, c = f.st_ctim;
#endif
  *s = (ta_am_source_stamp){(uint64_t)f.st_size,
      (uint64_t)m.tv_sec * 1000000000u + m.tv_nsec,
      (uint64_t)c.tv_sec * 1000000000u + c.tv_nsec,
      (uint64_t)f.st_ino, (uint32_t)f.st_dev};
  return 1;
}
static int source_open(const char *path) {
  if (!path || !*path || strstr(path, "://")) return -1;
  return open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
}
int ta_am_source_snapshot(const char *path, ta_am_source_stamp *s) {
  if (!s) return 0;
  int fd = source_open(path);
  if (fd < 0) return 0;
  int ok = stamp(fd, s);
  close(fd);
  return ok;
}
ta_am_source_lease *ta_am_source_acquire(const char *path,
    const ta_am_source_stamp *expected, const char hash[65], const ta_am_cancel *cancel) {
  int fd = source_open(path);
  if (fd < 0) return NULL;
  ta_am_source_lease *lease = ta_am_source_acquire_fd(fd, expected, hash, cancel);
  close(fd);
  return lease;
}
int ta_am_source_snapshot_fd(int fd, ta_am_source_stamp *s) { return s && stamp(fd, s); }
int ta_am_source_sha256_fd(int fd, char hex[65], const ta_am_cancel *cancel) {
  ta_am_source_stamp before, after;
  if (ta_am_cancelled(cancel) || !stamp(fd, &before)) return 0;
  sha256 digest = initialise();
  unsigned char bytes[32768];
  uint64_t total = 0;
  for (;;) {
    if (ta_am_cancelled(cancel)) return 0;
    ssize_t got = pread(fd, bytes, sizeof(bytes), (off_t)total);
    if (got < 0 && errno == EINTR) continue;
    if (got < 0) return 0;
    if (!got) break;
    update(&digest, bytes, (size_t)got); total += (size_t)got;
  }
  if (ta_am_cancelled(cancel) || total != before.size || !stamp(fd, &after) ||
      !ta_am_source_stamp_equal(&before, &after)) return 0;
  finish(&digest, hex); return 1;
}
ta_am_source_lease *ta_am_source_acquire_fd(int fd, const ta_am_source_stamp *expected,
    const char hash[65], const ta_am_cancel *cancel) {
  fd = fcntl(fd, F_DUPFD_CLOEXEC, 0);
  if (fd < 0) return NULL;
  ta_am_source_stamp before, after;
  char hex[65];
  if (!stamp(fd, &before) || !ta_am_source_stamp_equal(expected, &before) ||
      !ta_am_source_sha256_fd(fd, hex, cancel) || !hash || strcmp(hash, hex) ||
      !stamp(fd, &after) || !ta_am_source_stamp_equal(&before, &after)) goto fail;
  ta_am_source_lease *lease = malloc(sizeof(*lease));
  if (!lease) goto fail;
  lease->file = fd; lease->stamp = before;
  return lease;
fail:
  close(fd); return NULL;
}
void ta_am_source_release(ta_am_source_lease *s) { if (s) { close(s->file); free(s); } }
int ta_am_source_valid(const ta_am_source_lease *s) {
  ta_am_source_stamp actual;
  return s && stamp(s->file, &actual) && ta_am_source_stamp_equal(&s->stamp, &actual);
}
#endif

int ta_am_source_sha256(const char *path, char hex[65], const ta_am_cancel *cancel) {
  ta_am_source_stamp before, after;
  if (ta_am_cancelled(cancel) || !ta_am_source_snapshot(path, &before)) return 0;
  FILE *file = ta_am_open_read(path);
  if (!file) return 0;
  sha256 digest = initialise();
  unsigned char bytes[32768];
  uint64_t total = 0;
  size_t got;
  while (!ta_am_cancelled(cancel) && (got = fread(bytes, 1, sizeof(bytes), file))) {
    update(&digest, bytes, got); total += got;
  }
  int ok = !ferror(file) && !ta_am_cancelled(cancel) && total == before.size &&
      ta_am_source_snapshot(path, &after) && ta_am_source_stamp_equal(&before, &after);
  fclose(file);
  if (ok) finish(&digest, hex);
  return ok;
}
