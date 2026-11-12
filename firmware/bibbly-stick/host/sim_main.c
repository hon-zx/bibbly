/*
 * stick-sim: the Bibbly Stick firmware logic running on a computer.
 *
 * Speaks the link protocol on stdin/stdout, exactly as the Stick does over its
 * USB sync interface, so the desktop app (and tests) can be developed without
 * hardware. Logs go to stderr. Recordings live in a temporary "microSD card"
 * directory that is removed on exit unless --dir is given.
 *
 *   stick-sim [--demo-recordings] [--dir DIR] [--plain] [--no-clock] [--verbose]
 *   stick-sim --wav-from-pcm IN.raw OUT.wav [--epoch MS] [--plain]
 *
 * Signals stand in for the button: SIGUSR1 long press (record), SIGUSR2 short
 * press, SIGHUP double press (mode). Closing stdin shuts the Stick down cleanly.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "stick_device.h"
#include "stick_dsp.h"
#include "synth.h"

#define SIM_FIRMWARE "0.1.0-sim"
#define SIM_CAPACITY 31914983424ull /* a "32 GB" microSD card */

/* Development key for the simulator only. Real Sticks generate a random key on first boot. */
static const uint8_t SIM_KEY[STICK_KEY_LEN] = "bibbly-stick-simulator-dev-key!";

typedef struct {
  struct timespec t0;
  int64_t epoch_offset;
  bool clock_set;
  stick_store_t *store;
  stick_device_t *dev;
  bool recording;
  uint32_t rec_started;
  uint64_t fed;
  synth_t synth;
  bool verbose;
} sim_t;

static volatile sig_atomic_t sig_long, sig_short, sig_double, sig_quit;

static void on_signal(int sig) {
  if (sig == SIGUSR1) sig_long = 1;
  else if (sig == SIGUSR2) sig_short = 1;
  else if (sig == SIGHUP) sig_double = 1;
  else sig_quit = 1;
}

static uint32_t uptime_ms(void *ctx) {
  sim_t *s = (sim_t *)ctx;
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint32_t)((t.tv_sec - s->t0.tv_sec) * 1000 + (t.tv_nsec - s->t0.tv_nsec) / 1000000);
}

static uint64_t wall_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_REALTIME, &t);
  return (uint64_t)t.tv_sec * 1000u + (uint64_t)t.tv_nsec / 1000000u;
}

static uint64_t epoch_ms(void *ctx) {
  sim_t *s = (sim_t *)ctx;
  return s->clock_set ? (uint64_t)(s->epoch_offset + uptime_ms(ctx)) : 0;
}

static void set_epoch_ms(void *ctx, uint64_t ms) {
  sim_t *s = (sim_t *)ctx;
  s->epoch_offset = (int64_t)ms - (int64_t)uptime_ms(ctx);
  s->clock_set = true;
}

static void space(void *ctx, uint64_t *total, uint64_t *free_bytes) {
  sim_t *s = (sim_t *)ctx;
  uint64_t used = stick_store_bytes(s->store) + stick_recorder_bytes(&s->dev->rec);
  *total = SIM_CAPACITY;
  *free_bytes = used < SIM_CAPACITY ? SIM_CAPACITY - used : 0;
}

static void on_recording(void *ctx, bool recording) {
  sim_t *s = (sim_t *)ctx;
  s->recording = recording;
  s->rec_started = uptime_ms(ctx);
  s->fed = 0;
  if (s->verbose) fprintf(stderr, "[stick-sim] recording %s\n", recording ? "started" : "stopped");
}

static void on_mode(void *ctx, uint8_t mode) {
  if (((sim_t *)ctx)->verbose) fprintf(stderr, "[stick-sim] mode %u\n", mode);
}

static void on_event(void *ctx, uint8_t code, const uint8_t *payload, size_t len) {
  if (((sim_t *)ctx)->verbose)
    fprintf(stderr, "[stick-sim] event 0x%02x (%zu bytes, first %u)\n", code, len, len ? payload[0] : 0);
}

static void send_stdout(void *ctx, const uint8_t *bytes, size_t len) {
  (void)ctx;
  while (len) {
    ssize_t n = write(STDOUT_FILENO, bytes, len);
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) {
      sig_quit = 1; /* the app went away */
      return;
    }
    bytes += n;
    len -= (size_t)n;
  }
}

static void random_bytes(void *ctx, uint8_t *out, size_t len) {
  (void)ctx;
  FILE *f = fopen("/dev/urandom", "rb");
  size_t got = f ? fread(out, 1, len, f) : 0;
  if (f) fclose(f);
  for (size_t i = got; i < len; i++) out[i] = (uint8_t)rand();
}

static void remove_tree(const char *root) {
  char rec[512], path[1024];
  snprintf(rec, sizeof(rec), "%s/REC", root);
  DIR *d = opendir(rec);
  if (d) {
    struct dirent *e;
    while ((e = readdir(d)) != NULL) {
      if (e->d_name[0] == '.') continue;
      snprintf(path, sizeof(path), "%s/%s", rec, e->d_name);
      unlink(path);
    }
    closedir(d);
  }
  rmdir(rec);
  rmdir(root);
}

/* Local time today/yesterday at hh:mm, as epoch milliseconds. */
static uint64_t local_at(int days_ago, int hh, int mm) {
  time_t now = time(NULL);
  struct tm tm;
  localtime_r(&now, &tm);
  tm.tm_mday -= days_ago;
  tm.tm_hour = hh;
  tm.tm_min = mm;
  tm.tm_sec = 0;
  tm.tm_isdst = -1;
  return (uint64_t)mktime(&tm) * 1000u;
}

static int record_synth(stick_store_t *store, uint64_t epoch, uint32_t seconds, uint32_t seed, uint16_t *id) {
  stick_recorder_t rec = {0};
  synth_t syn;
  synth_init(&syn, seed);
  int rc = stick_recorder_start(&rec, store, epoch, NULL);
  int16_t pcm[1600];
  for (uint32_t i = 0; rc == STICK_OK && i < seconds * 10; i++) {
    synth_fill(&syn, pcm, 1600);
    rc = stick_recorder_write(&rec, pcm, 1600);
  }
  if (rc != STICK_OK) {
    stick_recorder_abort(&rec);
    return rc;
  }
  return stick_recorder_stop(&rec, id);
}

static void make_demo_recordings(stick_store_t *store) {
  const uint64_t now = wall_ms();
  uint64_t morning = local_at(0, 9, 12);
  if (morning > now) morning = local_at(1, 9, 12);
  const uint64_t when[3] = {local_at(1, 16, 5), morning, now - 40u * 60u * 1000u};
  const uint32_t seconds[3] = {9, 15, 6};
  /* Oldest first, so recording ids follow the clock. */
  for (int i = 0; i < 3; i++) {
    uint16_t id = 0;
    if (record_synth(store, when[i], seconds[i], 0xb1bb1e00u + (uint32_t)i, &id) == STICK_OK && i == 0)
      stick_store_mark_synced(store, id); /* the oldest was already imported */
  }
}

static int wav_from_pcm(const char *in, const char *out, uint64_t epoch, stick_cipher_t *cipher) {
  FILE *f = fopen(in, "rb");
  if (!f) {
    fprintf(stderr, "[stick-sim] cannot open %s\n", in);
    return 2;
  }
  char root[] = "/tmp/bibbly-stick-XXXXXX";
  if (!mkdtemp(root)) return 2;
  char dir[600];
  snprintf(dir, sizeof(dir), "%s/REC", root);
  static stick_store_t store;
  int rc = stick_store_open(&store, dir, cipher);
  stick_recorder_t rec = {0};
  uint16_t id = 0;
  if (rc == STICK_OK) rc = stick_recorder_start(&rec, &store, epoch, NULL);
  int16_t pcm[4096];
  size_t n;
  while (rc == STICK_OK && (n = fread(pcm, sizeof(int16_t), 4096, f)) > 0) rc = stick_recorder_write(&rec, pcm, n);
  fclose(f);
  if (rc == STICK_OK) rc = stick_recorder_stop(&rec, &id);
  const stick_rec_t *r = rc == STICK_OK ? stick_store_get(&store, id) : NULL;
  FILE *o = r ? fopen(out, "wb") : NULL;
  uint8_t buf[4089];
  for (uint32_t off = 0; o && r && off < r->size;) {
    uint32_t got = 0;
    if (stick_store_read(&store, id, off, buf, sizeof(buf), &got) != STICK_OK || !got) break;
    fwrite(buf, 1, got, o);
    off += got;
  }
  if (o) fclose(o);
  if (r) printf("{\"id\":%u,\"size\":%u,\"durationMs\":%u,\"encrypted\":%s}\n", id, r->size, r->duration_ms,
                stick_store_encrypted(&store) ? "true" : "false");
  stick_store_close(&store);
  remove_tree(root);
  return r ? 0 : 1;
}

int main(int argc, char **argv) {
  bool demo = false, plain = false, no_clock = false, verbose = false;
  const char *dir_arg = NULL, *pcm_in = NULL, *wav_out = NULL;
  uint64_t epoch = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--demo-recordings")) demo = true;
    else if (!strcmp(argv[i], "--plain")) plain = true;
    else if (!strcmp(argv[i], "--no-clock")) no_clock = true;
    else if (!strcmp(argv[i], "--verbose")) verbose = true;
    else if (!strcmp(argv[i], "--dir") && i + 1 < argc) dir_arg = argv[++i];
    else if (!strcmp(argv[i], "--epoch") && i + 1 < argc) epoch = strtoull(argv[++i], NULL, 10);
    else if (!strcmp(argv[i], "--wav-from-pcm") && i + 2 < argc) {
      pcm_in = argv[++i];
      wav_out = argv[++i];
    } else {
      fprintf(stderr, "usage: stick-sim [--demo-recordings] [--dir DIR] [--plain] [--no-clock] [--verbose]\n"
                      "       stick-sim --wav-from-pcm IN.raw OUT.wav [--epoch MS] [--plain]\n");
      return 2;
    }
  }

  static stick_cipher_t cipher;
  stick_cipher_t *cipher_ptr = NULL;
  if (!plain && stick_cipher_aes_init(&cipher, SIM_KEY, random_bytes, NULL)) cipher_ptr = &cipher;
  if (pcm_in) return wav_from_pcm(pcm_in, wav_out, epoch, cipher_ptr);

  char root[600];
  bool temporary = dir_arg == NULL;
  if (temporary) {
    snprintf(root, sizeof(root), "%s/bibbly-stick-XXXXXX", getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp");
    if (!mkdtemp(root)) {
      perror("[stick-sim] mkdtemp");
      return 1;
    }
  } else {
    snprintf(root, sizeof(root), "%s", dir_arg);
    mkdir(root, 0775);
  }
  char dir[700];
  snprintf(dir, sizeof(dir), "%s/REC", root);

  static sim_t sim;
  static stick_store_t store;
  static stick_device_t dev;
  static stick_link_t link;
  clock_gettime(CLOCK_MONOTONIC, &sim.t0);
  sim.verbose = verbose;
  sim.store = &store;
  sim.dev = &dev;
  synth_init(&sim.synth, 0x5eed);
  if (!no_clock) set_epoch_ms(&sim, wall_ms());
  if (stick_store_open(&store, dir, cipher_ptr) != STICK_OK) {
    fprintf(stderr, "[stick-sim] cannot open %s\n", dir);
    return 1;
  }
  if (demo && store.count == 0) make_demo_recordings(&store);

  const stick_platform_t platform = {
      .ctx = &sim, .uptime_ms = uptime_ms, .epoch_ms = epoch_ms, .set_epoch_ms = set_epoch_ms, .space = space,
      .on_mode = on_mode, .on_recording = on_recording, .on_event = on_event,
  };
  stick_identity_t identity = {.hardware = 0x0001, .caps = STICK_CAP_USB_MIC | STICK_CAP_HID | STICK_CAP_BLE | STICK_CAP_BATTERY,
                               .flash_kb = 16384, .serial = {0xbb, 0x51, 0x4d, 0x00, 0x00, 0x00, 0x00, 0x01}};
  snprintf(identity.firmware, sizeof(identity.firmware), "%s", SIM_FIRMWARE);
  stick_device_init(&dev, &platform, &identity, &store, STICK_MODE_MEETING_MIC, false);
  stick_device_attach(&dev, &link, send_stdout, NULL);
  stick_device_link_state(&dev, &link, true);
  stick_device_usb(&dev, true, false);
  stick_device_battery(&dev, 82, true);

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_signal;
  sigaction(SIGUSR1, &sa, NULL);
  sigaction(SIGUSR2, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  signal(SIGPIPE, SIG_IGN);
  fprintf(stderr, "[stick-sim] ready: %u recording(s) in %s (%s)%s\n", store.count, dir,
          cipher_ptr ? "encrypted" : "plain", store.repaired ? ", repaired unfinished files" : "");

  uint8_t buf[4096];
  int16_t pcm[1600];
  while (!sig_quit) {
    struct pollfd pfd = {.fd = STDIN_FILENO, .events = POLLIN};
    int r = poll(&pfd, 1, 10);
    if (r > 0 && (pfd.revents & (POLLIN | POLLHUP | POLLERR))) {
      ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
      if (n > 0) stick_device_rx(&dev, &link, buf, (size_t)n);
      else if (n == 0 || (errno != EINTR && errno != EAGAIN)) break; /* the app closed the link */
    }
    if (sig_long) { sig_long = 0; stick_device_gesture(&dev, STICK_GESTURE_LONG); }
    if (sig_short) { sig_short = 0; stick_device_gesture(&dev, STICK_GESTURE_SHORT); }
    if (sig_double) { sig_double = 0; stick_device_gesture(&dev, STICK_GESTURE_DOUBLE); }
    if (sim.recording) {
      /* Feed the recorder in real time with synthesised talk, as the microphones would. */
      const uint64_t due = (uint64_t)(uint32_t)(uptime_ms(&sim) - sim.rec_started) * 16u;
      while (sim.recording && sim.fed < due) {
        size_t n = (size_t)(due - sim.fed < 1600 ? due - sim.fed : 1600);
        synth_fill(&sim.synth, pcm, n);
        stick_device_level(&dev, stick_level_db10(pcm, n));
        stick_device_audio(&dev, pcm, n);
        sim.fed += n;
      }
    } else {
      stick_device_level(&dev, -620);
    }
    stick_device_tick(&dev);
  }

  if (stick_device_recording(&dev)) stick_device_record(&dev, false, NULL);
  stick_store_close(&store);
  if (cipher_ptr) stick_cipher_free(&cipher);
  if (temporary) remove_tree(root);
  fprintf(stderr, "[stick-sim] bye\n");
  return 0;
}
