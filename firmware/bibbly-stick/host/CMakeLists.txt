# Host build of the Bibbly Stick firmware logic: unit tests and the simulator
# the desktop app talks to when no Stick is plugged in.
#
#   cmake -S firmware/bibbly-stick/host -B build/firmware-host -G Ninja
#   cmake --build build/firmware-host && ctest --test-dir build/firmware-host
#
# (or: npm run firmware:test from the repository root)
cmake_minimum_required(VERSION 3.16)
project(bibbly_stick_host C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

add_subdirectory(${CMAKE_CURRENT_LIST_DIR}/../components/stick_core ${CMAKE_BINARY_DIR}/stick_core)
set(STICK_WARNINGS -Wall -Wextra -Wpedantic -Wshadow -Wstrict-prototypes -Werror)
target_compile_options(stick_core PRIVATE ${STICK_WARNINGS})

# AES for encrypted recordings: the system mbedTLS (libmbedtls-dev), or the
# copy bundled with ESP-IDF when IDF_PATH is set. Without either, the
# simulator keeps recordings as plain WAV files, like a build without AES.
find_path(MBEDTLS_INCLUDE_DIR mbedtls/aes.h)
# Prefer the static library: stick-sim is built once in CI and run on other
# machines (the apps job, the desktop app), which may not have mbedTLS installed.
find_library(MBEDCRYPTO_LIBRARY NAMES libmbedcrypto.a mbedcrypto)
if(DEFINED ENV{IDF_PATH})
  set(STICK_IDF_MBEDTLS "$ENV{IDF_PATH}/components/mbedtls/mbedtls" CACHE PATH "mbedTLS sources inside ESP-IDF")
endif()
set(IDF_MBEDTLS "${STICK_IDF_MBEDTLS}")
if(MBEDTLS_INCLUDE_DIR AND MBEDCRYPTO_LIBRARY)
  message(STATUS "Stick AES: system mbedTLS (${MBEDCRYPTO_LIBRARY})")
  target_include_directories(stick_core PRIVATE ${MBEDTLS_INCLUDE_DIR})
  target_link_libraries(stick_core PUBLIC ${MBEDCRYPTO_LIBRARY})
  target_compile_definitions(stick_core PRIVATE STICK_HAVE_MBEDTLS=1)
elseif(IDF_MBEDTLS AND EXISTS "${IDF_MBEDTLS}/library/aes.c")
  message(STATUS "Stick AES: mbedTLS from ESP-IDF (${IDF_MBEDTLS})")
  add_library(stick_aes STATIC ${IDF_MBEDTLS}/library/aes.c ${IDF_MBEDTLS}/library/platform_util.c)
  target_include_directories(stick_aes PUBLIC ${IDF_MBEDTLS}/include ${CMAKE_CURRENT_LIST_DIR}/mbedtls
                             PRIVATE ${IDF_MBEDTLS}/library)
  target_compile_definitions(stick_aes PUBLIC MBEDTLS_CONFIG_FILE="stick_mbedtls_config.h")
  target_link_libraries(stick_core PUBLIC stick_aes)
  target_compile_definitions(stick_core PRIVATE STICK_HAVE_MBEDTLS=1)
else()
  message(WARNING "mbedTLS not found: the simulator will store recordings unencrypted. "
                  "Install libmbedtls-dev or set IDF_PATH to test encryption.")
endif()

add_executable(stick-sim sim_main.c synth.c)
target_link_libraries(stick-sim PRIVATE stick_core)
target_compile_options(stick-sim PRIVATE ${STICK_WARNINGS})

add_executable(stick-tests tests/main.c tests/test_link.c tests/test_audio.c tests/test_store.c tests/test_ui.c
                           tests/test_dsp.c tests/test_device.c synth.c)
target_include_directories(stick-tests PRIVATE ${CMAKE_CURRENT_LIST_DIR})
target_link_libraries(stick-tests PRIVATE stick_core)
target_compile_options(stick-tests PRIVATE ${STICK_WARNINGS})

enable_testing()
add_test(NAME stick-core COMMAND stick-tests)
add_test(NAME stick-sim-smoke COMMAND ${CMAKE_COMMAND} -DSIM=$<TARGET_FILE:stick-sim> -DOUT=${CMAKE_BINARY_DIR}
         -P ${CMAKE_CURRENT_LIST_DIR}/tests/sim_smoke.cmake)
