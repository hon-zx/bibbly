#include "stick_store.h"

#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "stick_link.h"

static const uint8_t ENC_MAGIC[8] = {'B', 'B', 'L', 'Y', 'E', 'N', 'C', '1'};

static void put32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
  p[2] = (uint8_t)(v >> 16);
  p[3] = (uint8_t)(v >> 24);
}

static const char *data_ext(const stick_store_t *s) { return s->cipher ? "BBY" : "WAV"; }

static void rec_path(const stick_store_t *s, uint16_t id, const char *ext, char *out, size_t cap) {
  snprintf(out, cap, "%s/R%05u.%s", s->dir, (unsigned)id, ext);
}

static bool exists(const char *path) {
  struct stat st;
  return stat(path, &st) == 0;
}

static void xcrypt(stick_store_t *s, const uint8_t *nonce, uint64_t offset, uint8_t *buf, size_t len) {
  if (s->cipher) s->cipher->xcrypt(s->cipher, nonce, offset, buf, len);
}

/* "R00042.BBY" -> 42, "BBY". */
static bool parse_name(const char *name, uint16_t *id, char ext[4]) {
  if (strlen(name) != 10 || (name[0] != 'R' && name[0] != 'r') || name[6] != '.') return false;
  unsigned v = 0;
  for (int i = 1; i <= 5; i++) {
    if (name[i] < '0' || name[i] > '9') return false;
    v = v * 10 + (unsigned)(name[i] - '0');
  }
  if (v == 0 || v > 65535) return false;
  for (int i = 0; i < 3; i++) {
    char c = name[7 + i];
    ext[i] = (char)((c >= 'a' && c <= 'z') ? c - 32 : c);
  }
  ext[3] = 0;
  *id = (uint16_t)v;
  return true;
}

static int find_index(const stick_store_t *s, uint16_t id) {
  int lo = 0, hi = (int)s->count - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    if (s->recs[mid].id == id) return mid;
    if (s->recs[mid].id < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

static void index_add(stick_store_t *s, const stick_rec_t *rec) {
  if (s->count >= STICK_MAX_RECORDINGS) return;
  int i = (int)s->count;
  while (i > 0 && s->recs[i - 1].id > rec->id) {
    s->recs[i] = s->recs[i - 1];
    i--;
  }
  s->recs[i] = *rec;
  s->count++;
}

static void close_cache(stick_store_t *s) {
  if (s->rf) fclose(s->rf);
  s->rf = NULL;
  s->rf_id = 0;
}

/* Reads the container header; returns the plaintext offset base, or -1 if this isn't one of our files. */
static long read_container(stick_store_t *s, FILE *f, uint8_t nonce[STICK_NONCE_LEN]) {
  memset(nonce, 0, STICK_NONCE_LEN);
  if (!s->cipher) return 0;
  uint8_t h[STICK_ENC_HEADER];
  if (fread(h, 1, sizeof(h), f) != sizeof(h) || memcmp(h, ENC_MAGIC, sizeof(ENC_MAGIC)) != 0) return -1;
  memcpy(nonce, h + 8, STICK_NONCE_LEN);
  return STICK_ENC_HEADER;
}

typedef enum { INDEX_OK, INDEX_SKIP, INDEX_EMPTY } index_result_t;

/* Indexes one recording, repairing the header of a file cut off by a power loss. */
static index_result_t index_file(stick_store_t *s, uint16_t id, const char *path) {
  FILE *f = fopen(path, "r+b");
  if (!f) return INDEX_SKIP;
  uint8_t nonce[STICK_NONCE_LEN];
  long hdr = read_container(s, f, nonce);
  if (hdr < 0 || fseek(f, 0, SEEK_END) != 0) {
    fclose(f);
    return INDEX_SKIP; /* not ours, or encrypted with another Stick's key: leave it alone */
  }
  long file_size = ftell(f);
  uint8_t w[STICK_WAV_HEADER_LEN];
  stick_wav_info_t info;
  if (file_size < hdr + STICK_WAV_HEADER_LEN || fseek(f, hdr, SEEK_SET) != 0 || fread(w, 1, sizeof(w), f) != sizeof(w)) {
    fclose(f);
    return INDEX_SKIP;
  }
  xcrypt(s, nonce, 0, w, sizeof(w));
  if (!stick_wav_parse(w, sizeof(w), &info)) {
    fclose(f);
    return INDEX_SKIP;
  }
  const uint32_t plain = (uint32_t)(file_size - hdr);
  const uint32_t avail = (plain - STICK_WAV_HEADER_LEN) / STICK_BLOCK_ALIGN * STICK_BLOCK_ALIGN;
  if (info.data_len != avail || info.data_len == 0) {
    if (avail == 0) {
      fclose(f);
      return INDEX_EMPTY;
    }
    /* Unfinished: the recorder never wrote the final sizes. Keep every whole block. */
    const uint32_t whole = avail / STICK_BLOCK_ALIGN * STICK_SAMPLES_PER_BLOCK;
    if (info.samples == 0 || info.samples > whole) info.samples = whole;
    info.data_len = avail;
    stick_wav_header(w, info.sample_rate, info.samples, info.data_len, info.start_epoch_ms);
    xcrypt(s, nonce, 0, w, sizeof(w));
    bool ok = fseek(f, hdr, SEEK_SET) == 0 && fwrite(w, 1, sizeof(w), f) == sizeof(w) && fflush(f) == 0;
    fclose(f);
    if (!ok) return INDEX_SKIP;
    if (truncate(path, (off_t)(hdr + STICK_WAV_HEADER_LEN + avail)) != 0) {
      /* Trailing partial block stays on disk; readers stop at data_len. */
    }
    s->repaired++;
  } else {
    fclose(f);
  }
  const stick_rec_t rec = {
      .id = id,
      .flags = 0,
      .size = STICK_WAV_HEADER_LEN + info.data_len,
      .start_epoch_ms = info.start_epoch_ms,
      .duration_ms = stick_duration_ms(info.samples, info.sample_rate),
  };
  index_add(s, &rec);
  return INDEX_OK;
}

static int push_id(uint16_t **list, size_t *n, size_t *cap, uint16_t id) {
  if (*n == *cap) {
    size_t next = *cap ? *cap * 2 : 64;
    uint16_t *grown = (uint16_t *)realloc(*list, next * sizeof(uint16_t));
    if (!grown) return -1;
    *list = grown;
    *cap = next;
  }
  (*list)[(*n)++] = id;
  return 0;
}

int stick_store_open(stick_store_t *s, const char *dir, stick_cipher_t *cipher) {
  memset(s, 0, sizeof(*s));
  snprintf(s->dir, sizeof(s->dir), "%s", dir);
  s->cipher = (cipher && cipher->xcrypt) ? cipher : NULL;
  if (mkdir(dir, 0775) != 0 && errno != EEXIST) return STICK_ERR_IO;
  DIR *d = opendir(dir);
  if (!d) return STICK_ERR_IO;

  /* Collect names first: repairs and deletions must not run while the directory is being read. */
  uint16_t *data = NULL, *syn = NULL;
  size_t n_data = 0, cap_data = 0, n_syn = 0, cap_syn = 0;
  uint16_t max_id = 0;
  struct dirent *e;
  while ((e = readdir(d)) != NULL) {
    uint16_t id;
    char ext[4];
    if (!parse_name(e->d_name, &id, ext)) continue;
    if (id > max_id) max_id = id;
    if (strcmp(ext, "SYN") == 0) push_id(&syn, &n_syn, &cap_syn, id);
    else if (strcmp(ext, data_ext(s)) == 0) push_id(&data, &n_data, &cap_data, id);
  }
  closedir(d);

  char path[160];
  for (size_t i = 0; i < n_data; i++) {
    rec_path(s, data[i], data_ext(s), path, sizeof(path));
    if (index_file(s, data[i], path) == INDEX_EMPTY) unlink(path);
  }
  for (size_t i = 0; i < n_syn; i++) {
    int idx = find_index(s, syn[i]);
    if (idx >= 0) s->recs[idx].flags |= STICK_REC_SYNCED;
  }
  free(data);
  free(syn);
  s->next_id = max_id == 65535 ? 1 : (uint16_t)(max_id + 1);
  return STICK_OK;
}

void stick_store_close(stick_store_t *s) { close_cache(s); }

const stick_rec_t *stick_store_get(const stick_store_t *s, uint16_t id) {
  int idx = find_index(s, id);
  return idx >= 0 ? &s->recs[idx] : NULL;
}

bool stick_store_encrypted(const stick_store_t *s) { return s->cipher != NULL; }

uint64_t stick_store_bytes(const stick_store_t *s) {
  uint64_t total = 0;
  for (uint16_t i = 0; i < s->count; i++) total += s->recs[i].size + (s->cipher ? STICK_ENC_HEADER : 0);
  return total;
}

int stick_store_read(stick_store_t *s, uint16_t id, uint32_t offset, uint8_t *buf, uint32_t len, uint32_t *got) {
  *got = 0;
  const stick_rec_t *r = stick_store_get(s, id);
  if (!r) return STICK_ERR_NOT_FOUND;
  if (offset >= r->size) return STICK_ERR_BAD_REQUEST;
  if (len > r->size - offset) len = r->size - offset;
  if (!s->rf || s->rf_id != id) {
    close_cache(s);
    char path[160];
    rec_path(s, id, data_ext(s), path, sizeof(path));
    FILE *f = fopen(path, "rb");
    if (!f) return STICK_ERR_IO;
    long hdr = read_container(s, f, s->rf_nonce);
    if (hdr < 0) {
      fclose(f);
      return STICK_ERR_IO;
    }
    s->rf = f;
    s->rf_id = id;
    s->rf_hdr = (uint32_t)hdr;
  }
  if (fseek(s->rf, (long)(s->rf_hdr + offset), SEEK_SET) != 0 || fread(buf, 1, len, s->rf) != len) {
    close_cache(s);
    return STICK_ERR_IO;
  }
  xcrypt(s, s->rf_nonce, offset, buf, len);
  *got = len;
  return STICK_OK;
}

int stick_store_delete(stick_store_t *s, uint16_t id) {
  if (id != 0 && id == s->active_id) return STICK_ERR_BUSY;
  int idx = find_index(s, id);
  if (idx < 0) return STICK_ERR_NOT_FOUND;
  if (s->rf_id == id) close_cache(s);
  char path[160];
  rec_path(s, id, data_ext(s), path, sizeof(path));
  if (unlink(path) != 0 && errno != ENOENT) return STICK_ERR_IO;
  rec_path(s, id, "SYN", path, sizeof(path));
  unlink(path);
  memmove(&s->recs[idx], &s->recs[idx + 1], (size_t)(s->count - idx - 1) * sizeof(stick_rec_t));
  s->count--;
  return STICK_OK;
}

int stick_store_mark_synced(stick_store_t *s, uint16_t id) {
  int idx = find_index(s, id);
  if (idx < 0) return STICK_ERR_NOT_FOUND;
  if (s->recs[idx].flags & STICK_REC_SYNCED) return STICK_OK;
  char path[160];
  rec_path(s, id, "SYN", path, sizeof(path));
  FILE *f = fopen(path, "wb");
  if (!f) return STICK_ERR_IO;
  fclose(f);
  s->recs[idx].flags |= STICK_REC_SYNCED;
  return STICK_OK;
}

static uint16_t alloc_id(stick_store_t *s) {
  char path[160];
  for (uint32_t tries = 0; tries < 65535u; tries++) {
    uint16_t id = s->next_id ? s->next_id : 1;
    s->next_id = id == 65535 ? 1 : (uint16_t)(id + 1);
    if (stick_store_get(s, id) || id == s->active_id) continue;
    rec_path(s, id, data_ext(s), path, sizeof(path));
    if (exists(path)) continue; /* a file we couldn't index: never overwrite it */
    return id;
  }
  return 0;
}

int stick_recorder_start(stick_recorder_t *r, stick_store_t *s, uint64_t start_epoch_ms, uint16_t *id) {
  if (r->active) return STICK_ERR_BUSY;
  if (s->count >= STICK_MAX_RECORDINGS) return STICK_ERR_IO;
  memset(r, 0, sizeof(*r));
  const uint16_t nid = alloc_id(s);
  if (!nid) return STICK_ERR_IO;
  char path[160];
  rec_path(s, nid, data_ext(s), path, sizeof(path));
  FILE *f = fopen(path, "w+b");
  if (!f) return STICK_ERR_IO;
  r->store = s;
  if (s->cipher) {
    uint8_t h[STICK_ENC_HEADER] = {0};
    memcpy(h, ENC_MAGIC, sizeof(ENC_MAGIC));
    s->cipher->random(s->cipher->random_ctx, r->nonce, STICK_NONCE_LEN);
    memcpy(h + 8, r->nonce, STICK_NONCE_LEN);
    put32(h + 20, STICK_ENC_KEY_ID);
    if (fwrite(h, 1, sizeof(h), f) != sizeof(h)) goto fail;
    r->hdr = STICK_ENC_HEADER;
  }
  uint8_t w[STICK_WAV_HEADER_LEN];
  stick_wav_header(w, STICK_SAMPLE_RATE, 0, 0, start_epoch_ms);
  xcrypt(s, r->nonce, 0, w, sizeof(w));
  if (fwrite(w, 1, sizeof(w), f) != sizeof(w)) goto fail;
  r->f = f;
  r->id = nid;
  r->start_epoch_ms = start_epoch_ms;
  r->active = true;
  s->active_id = nid;
  if (id) *id = nid;
  return STICK_OK;
fail:
  fclose(f);
  unlink(path);
  return STICK_ERR_IO;
}

static int write_block(stick_recorder_t *r, size_t n) {
  stick_ima_encode_block(r->pcm, n, &r->st, r->block);
  const uint64_t offset = STICK_WAV_HEADER_LEN + (uint64_t)r->blocks * STICK_BLOCK_ALIGN;
  xcrypt(r->store, r->nonce, offset, r->block, sizeof(r->block));
  if (fwrite(r->block, 1, sizeof(r->block), r->f) != sizeof(r->block)) return STICK_ERR_IO;
  r->blocks++;
  r->fill = 0;
  return STICK_OK;
}

int stick_recorder_write(stick_recorder_t *r, const int16_t *pcm, size_t n) {
  if (!r->active) return STICK_ERR_BAD_REQUEST;
  while (n) {
    size_t take = STICK_SAMPLES_PER_BLOCK - r->fill;
    if (take > n) take = n;
    memcpy(r->pcm + r->fill, pcm, take * sizeof(int16_t));
    r->fill += take;
    r->samples += (uint32_t)take;
    pcm += take;
    n -= take;
    if (r->fill == STICK_SAMPLES_PER_BLOCK) {
      int rc = write_block(r, STICK_SAMPLES_PER_BLOCK);
      if (rc != STICK_OK) return rc;
    }
  }
  return STICK_OK;
}

int stick_recorder_flush(stick_recorder_t *r) {
  if (!r->active) return STICK_ERR_BAD_REQUEST;
  if (fflush(r->f) != 0) return STICK_ERR_IO;
  fsync(fileno(r->f));
  return STICK_OK;
}

int stick_recorder_stop(stick_recorder_t *r, uint16_t *id) {
  if (!r->active) return STICK_ERR_BAD_REQUEST;
  int rc = STICK_OK;
  if (r->fill > 0 || r->blocks == 0) rc = write_block(r, r->fill);
  const uint32_t data_len = r->blocks * STICK_BLOCK_ALIGN;
  if (rc == STICK_OK) {
    uint8_t w[STICK_WAV_HEADER_LEN];
    stick_wav_header(w, STICK_SAMPLE_RATE, r->samples, data_len, r->start_epoch_ms);
    xcrypt(r->store, r->nonce, 0, w, sizeof(w));
    if (fseek(r->f, (long)r->hdr, SEEK_SET) != 0 || fwrite(w, 1, sizeof(w), r->f) != sizeof(w)) rc = STICK_ERR_IO;
  }
  if (fflush(r->f) != 0) rc = STICK_ERR_IO;
  fsync(fileno(r->f));
  fclose(r->f);
  r->f = NULL;
  r->active = false;
  stick_store_t *s = r->store;
  s->active_id = 0;
  if (rc != STICK_OK) return rc; /* the next stick_store_open repairs the header */
  const stick_rec_t rec = {
      .id = r->id,
      .flags = 0,
      .size = STICK_WAV_HEADER_LEN + data_len,
      .start_epoch_ms = r->start_epoch_ms,
      .duration_ms = stick_duration_ms(r->samples, STICK_SAMPLE_RATE),
  };
  index_add(s, &rec);
  if (id) *id = r->id;
  return STICK_OK;
}

void stick_recorder_abort(stick_recorder_t *r) {
  if (!r->active) return;
  fclose(r->f);
  r->f = NULL;
  r->active = false;
  stick_store_t *s = r->store;
  s->active_id = 0;
  /* Keep whatever reached the card: repair the header now so the recording shows up. */
  char path[160];
  rec_path(s, r->id, data_ext(s), path, sizeof(path));
  if (index_file(s, r->id, path) == INDEX_EMPTY) unlink(path);
}

uint32_t stick_recorder_ms(const stick_recorder_t *r) {
  return r->active ? stick_duration_ms(r->samples, STICK_SAMPLE_RATE) : 0;
}

uint64_t stick_recorder_bytes(const stick_recorder_t *r) {
  if (!r->active) return 0;
  return STICK_WAV_HEADER_LEN + (uint64_t)r->blocks * STICK_BLOCK_ALIGN + (r->fill ? STICK_BLOCK_ALIGN : 0);
}
