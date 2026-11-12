#define _GNU_SOURCE
#include <dirent.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include "test.h"

int t_checks;
int t_failures;

static char root[256];

static void wipe(const char *dir) {
  DIR *d = opendir(dir);
  if (!d) return;
  struct dirent *e;
  char path[1024];
  while ((e = readdir(d)) != NULL) {
    if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
    snprintf(path, sizeof(path), "%s/%s", dir, e->d_name);
    struct stat st;
    if (stat(path, &st) == 0 && S_ISDIR(st.st_mode)) wipe(path);
    else unlink(path);
  }
  closedir(d);
  rmdir(dir);
}

const char *test_dir(const char *name) {
  static char path[512];
  snprintf(path, sizeof(path), "%s/%s", root, name);
  wipe(path);
  return path;
}

int main(void) {
  snprintf(root, sizeof(root), "%s/stick-tests-XXXXXX", getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp");
  if (!mkdtemp(root)) return 2;
  struct { const char *name; void (*fn)(void); } suites[] = {
      {"link", test_link}, {"audio", test_audio}, {"store", test_store},
      {"ui", test_ui},     {"dsp", test_dsp},     {"device", test_device},
  };
  for (size_t i = 0; i < sizeof(suites) / sizeof(suites[0]); i++) {
    int before = t_failures;
    suites[i].fn();
    printf("%-7s %s\n", suites[i].name, t_failures == before ? "ok" : "FAILED");
  }
  wipe(root);
  printf("%d checks, %d failed\n", t_checks, t_failures);
  return t_failures ? 1 : 0;
}
