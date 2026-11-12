#include <math.h>

#include "stick_audio.h"
#include "test.h"

static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24; }
static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }

void test_audio(void) {
  /* ADPCM keeps a sine recognisable: better than 25 dB signal-to-noise. */
  enum { N = STICK_SAMPLES_PER_BLOCK * 3 };
  static int16_t pcm[N], dec[N];
  for (int i = 0; i < N; i++) pcm[i] = (int16_t)lrint(16000.0 * sin(2 * M_PI * 440.0 * i / 16000.0));
  static uint8_t blocks[3][STICK_BLOCK_ALIGN];
  stick_ima_state_t st = {0, 0};
  for (int b = 0; b < 3; b++) {
    const uint8_t index_before = st.index;
    stick_ima_encode_block(pcm + b * STICK_SAMPLES_PER_BLOCK, STICK_SAMPLES_PER_BLOCK, &st, blocks[b]);
    CHECK_EQ(blocks[b][2], index_before); /* the step index carries over between blocks */
    CHECK_EQ((int16_t)rd16(blocks[b]), pcm[b * STICK_SAMPLES_PER_BLOCK]);
  }
  size_t got = 0;
  for (int b = 0; b < 3; b++) got += stick_ima_decode_block(blocks[b], STICK_BLOCK_ALIGN, dec + got, N - got);
  CHECK_EQ(got, N);
  double sig = 0, noise = 0;
  for (int i = 0; i < N; i++) {
    sig += (double)pcm[i] * pcm[i];
    noise += ((double)pcm[i] - dec[i]) * ((double)pcm[i] - dec[i]);
  }
  CHECK(10 * log10(sig / noise) > 25.0);

  /* An empty block is silence, like encodeIma() of nothing. */
  stick_ima_state_t zero = {0, 0};
  uint8_t empty[STICK_BLOCK_ALIGN];
  stick_ima_encode_block(NULL, 0, &zero, empty);
  int nonzero = 0;
  for (int i = 0; i < STICK_BLOCK_ALIGN; i++) nonzero += empty[i] != 0;
  CHECK_EQ(nonzero, 0);

  /* Header layout matches encodeWavIma() in packages/core/src/audio/wav.ts. */
  uint8_t h[STICK_WAV_HEADER_LEN];
  stick_wav_header(h, 16000, 32000, 32 * STICK_BLOCK_ALIGN, 1794470400000ull);
  CHECK(!memcmp(h, "RIFF", 4) && !memcmp(h + 8, "WAVE", 4) && !memcmp(h + 12, "fmt ", 4));
  CHECK_EQ(rd32(h + 4), 72 + 32 * STICK_BLOCK_ALIGN);
  CHECK_EQ(rd32(h + 16), 20);
  CHECK_EQ(rd16(h + 20), 0x11);
  CHECK_EQ(rd16(h + 22), 1);
  CHECK_EQ(rd32(h + 24), 16000);
  CHECK_EQ(rd32(h + 28), 8055); /* Math.round(16000 * 512 / 1017) */
  CHECK_EQ(rd16(h + 32), 512);
  CHECK_EQ(rd16(h + 34), 4);
  CHECK_EQ(rd16(h + 36), 2);
  CHECK_EQ(rd16(h + 38), 1017);
  CHECK(!memcmp(h + 40, "fact", 4) && !memcmp(h + 52, "bbly", 4) && !memcmp(h + 72, "data", 4));
  CHECK_EQ(rd32(h + 48), 32000);
  CHECK_EQ(rd32(h + 60), 1);
  CHECK_EQ(rd32(h + 64), (uint32_t)(1794470400000ull & 0xffffffffu));
  CHECK_EQ(rd32(h + 68), (uint32_t)(1794470400000ull >> 32));
  CHECK_EQ(rd32(h + 76), 32 * STICK_BLOCK_ALIGN);
  stick_wav_info_t info;
  CHECK(stick_wav_parse(h, sizeof(h), &info));
  CHECK(info.start_epoch_ms == 1794470400000ull);
  CHECK_EQ(info.samples, 32000);
  h[20] = 1; /* PCM, not ours */
  CHECK(!stick_wav_parse(h, sizeof(h), &info));

  CHECK_EQ(stick_duration_ms(16000 * 3 + 8, 16000), 3000);
  int16_t fs[1600];
  for (int i = 0; i < 1600; i++) fs[i] = (int16_t)lrint(32767.0 * sin(2 * M_PI * 500.0 * i / 16000.0));
  int16_t lvl = stick_level_db10(fs, 1600);
  CHECK(lvl <= -28 && lvl >= -32); /* a full-scale sine is -3 dBFS RMS */
  int16_t quiet[160] = {0};
  CHECK_EQ(stick_level_db10(quiet, 160), -1000);
}
