# Bibbly Stick firmware for the ESP32-S3 (ESP-IDF v5.5).
#
#   git submodule update --init third_party/tinyusb
#   idf.py set-target esp32s3
#   idf.py build flash monitor
#
# The portable logic in components/stick_core is also built and tested on a
# computer: see host/ (npm run firmware:test from the repository root).
cmake_minimum_required(VERSION 3.16)
set(PROJECT_VER "0.1.0")
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(bibbly-stick)
