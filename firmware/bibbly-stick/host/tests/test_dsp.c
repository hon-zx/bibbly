#include <math.h>
#include <stdlib.h>

#include "stick_audio.h"
#include "stick_dsp.h"
#include "stick_link.h"
#include "test.h"

void test_dsp(void) {
  static stick_dsp_t d;
  static int16_t in[16000 * 2], out[16000];

  /* A DC offset (a common MEMS/PDM artefact) is removed. */
  stick_dsp_init(&d, STICK_MODE_MEETING_MIC);
  for (int i = 0; i < 16000; i++) in[i] = 8000;
  stick_dsp_process(&d, in, 16000, 1, out);
  long sum = 0;
  for (int i = 8000; i < 16000; i++) sum += out[i];
  CHECK(labs(sum / 8000) < 50);

  /* Automatic gain lifts a quiet talker (-40 dBFS) to a usable level within a few seconds. */
  stick_dsp_init(&d, STICK_MODE_MEETING_MIC);
  int16_t last_level = -1000;
  for (int sec = 0; sec < 8; sec++) {
    for (int i = 0; i < 16000; i++) in[i] = (int16_t)lrint(328.0 * sin(2 * M_PI * 300.0 * (sec * 16000 + i) / 16000.0));
    stick_dsp_process(&d, in, 16000, 1, out);
    last_level = stick_level_db10(out, 16000);
  }
  CHECK(last_level > -300 && last_level < -140);

  /* Silence stays silent: no runaway gain, no NaNs. */
  stick_dsp_init(&d, STICK_MODE_ROOM);
  memset(in, 0, sizeof(in));
  stick_dsp_process(&d, in, 16000, 1, out);
  int peak = 0;
  for (int i = 0; i < 16000; i++) peak = abs(out[i]) > peak ? abs(out[i]) : peak;
  CHECK_EQ(peak, 0);

  /* A shout is limited, not wrapped around. */
  stick_dsp_init(&d, STICK_MODE_POCKET_RECORDER);
  for (int i = 0; i < 16000; i++) in[i] = (i / 20) % 2 ? 32767 : -32768;
  stick_dsp_process(&d, in, 16000, 1, out);
  int flips = 0;
  for (int i = 1000; i < 16000; i++) flips += (in[i] > 0) != (out[i] > 0) && abs(out[i]) > 16000;
  CHECK_EQ(flips, 0);

  /* The microphone pair is summed in phase: opposite signals cancel. */
  stick_dsp_init(&d, STICK_MODE_MEETING_MIC);
  for (int i = 0; i < 16000; i++) {
    int16_t v = (int16_t)lrint(8000.0 * sin(2 * M_PI * 1000.0 * i / 16000.0));
    in[2 * i] = v;
    in[2 * i + 1] = (int16_t)-v;
  }
  stick_dsp_process(&d, in, 16000, 2, out);
  CHECK(stick_level_db10(out + 8000, 8000) < -600);

  /* Host volume control. */
  stick_dsp_init(&d, STICK_MODE_MEETING_MIC);
  stick_dsp_set_volume_db(&d, -100);
  CHECK(fabsf(d.user_gain - 0.01f) < 0.001f);

  /* Ring buffer wraps and refuses to overfill. */
  static uint8_t store[16];
  stick_ringbuf_t rb;
  CHECK(!stick_rb_init(&rb, store, 12));
  CHECK(stick_rb_init(&rb, store, 16));
  uint8_t data[20], got[20];
  for (int i = 0; i < 20; i++) data[i] = (uint8_t)i;
  CHECK_EQ(stick_rb_write(&rb, data, 10), 10);
  CHECK_EQ(stick_rb_read(&rb, got, 6), 6);
  CHECK_EQ(stick_rb_write(&rb, data + 10, 10), 10); /* wraps */
  CHECK_EQ(stick_rb_used(&rb), 14);
  CHECK_EQ(stick_rb_write(&rb, data, 5), 2);
  CHECK_EQ(stick_rb_read(&rb, got, 20), 16);
  CHECK(got[0] == 6 && got[13] == 19 && got[14] == 0 && got[15] == 1);
  stick_rb_clear(&rb);
  CHECK_EQ(stick_rb_used(&rb), 0);
}
