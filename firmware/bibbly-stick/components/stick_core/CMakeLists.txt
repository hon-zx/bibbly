# Portable Bibbly Stick logic. Builds as an ESP-IDF component for the device
# and as a plain static library for the host tests and simulator (host/).
set(STICK_CORE_SRCS link.c audio.c crypt.c store.c ui.c dsp.c device.c)

if(ESP_PLATFORM)
  idf_component_register(SRCS ${STICK_CORE_SRCS}
                         INCLUDE_DIRS include
                         PRIV_REQUIRES mbedtls vfs)
  target_compile_definitions(${COMPONENT_LIB} PRIVATE STICK_HAVE_MBEDTLS=1)
else()
  add_library(stick_core STATIC ${STICK_CORE_SRCS})
  target_include_directories(stick_core PUBLIC include)
  target_link_libraries(stick_core PUBLIC m)
endif()
