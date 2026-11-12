/* A tiny test harness: CHECK macros count failures; main.c runs every suite. */
#pragma once

#include <stdio.h>
#include <string.h>

extern int t_checks;
extern int t_failures;

#define CHECK(cond)                                                                \
  do {                                                                             \
    t_checks++;                                                                    \
    if (!(cond)) {                                                                 \
      t_failures++;                                                                \
      fprintf(stderr, "%s:%d: CHECK(%s) failed\n", __FILE__, __LINE__, #cond);     \
    }                                                                              \
  } while (0)

#define CHECK_EQ(a, b)                                                             \
  do {                                                                             \
    long long _a = (long long)(a), _b = (long long)(b);                            \
    t_checks++;                                                                    \
    if (_a != _b) {                                                                \
      t_failures++;                                                                \
      fprintf(stderr, "%s:%d: %s == %s failed (%lld vs %lld)\n", __FILE__, __LINE__, \
              #a, #b, _a, _b);                                                     \
    }                                                                              \
  } while (0)

/* Makes a fresh empty directory for one test and returns its path (static storage). */
const char *test_dir(const char *name);

void test_link(void);
void test_audio(void);
void test_store(void);
void test_ui(void);
void test_dsp(void);
void test_device(void);
