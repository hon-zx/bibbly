#!/bin/sh
# Runs after the Bibbly .deb is installed: adds the udev rule that lets the
# signed-in user talk to the Bibbly Stick's sync interface without root.
# The microphone itself needs no setup (it is a standard USB audio device).
set -e
RULES=/etc/udev/rules.d/70-bibbly-stick.rules
cat > "$RULES" <<'RULES_EOF'
SUBSYSTEM=="usb", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="0001", TAG+="uaccess"
KERNEL=="hidraw*", ATTRS{idVendor}=="1209", ATTRS{idProduct}=="0001", TAG+="uaccess"
RULES_EOF
chmod 644 "$RULES"
if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules || true
  udevadm trigger --subsystem-match=usb --attr-match=idVendor=1209 || true
fi
exit 0
