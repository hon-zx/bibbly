# Starts the simulator with demo recordings and no app attached: it must
# create the recordings, see stdin close, shut down cleanly and exit 0.
execute_process(COMMAND ${SIM} --demo-recordings
                INPUT_FILE /dev/null
                RESULT_VARIABLE rc
                OUTPUT_VARIABLE out
                ERROR_VARIABLE err
                TIMEOUT 30)
if(NOT rc EQUAL 0)
  message(FATAL_ERROR "stick-sim exited with ${rc}: ${err}")
endif()
if(NOT err MATCHES "ready: 3 recording")
  message(FATAL_ERROR "stick-sim did not create the demo recordings: ${err}")
endif()
if(NOT err MATCHES "bye")
  message(FATAL_ERROR "stick-sim did not shut down cleanly: ${err}")
endif()
