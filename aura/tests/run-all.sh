#!/usr/bin/env bash
# AURA :: full verification suite
set -e
cd "$(dirname "$0")/.."

echo "════ NODE (no browser needed) ════"
for t in test-architecture test-core test-providers test-actions \
         test-live test-desktop test-router test-models test-voice-loop \
         test-gesture-wave test-desktop-tools test-vision-embeddings test-screen-agent \
         test-gestures-cursor test-task-agent test-runtime test-privacy-guard test-dwell test-doc-agent test-sphere; do
  printf "  %-20s " "$t"
  node "tests/$t.mjs" | grep -oE "PASS [0-9]+" | tail -1
done

PORT=8000
if ! curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/"; then
  echo ""
  echo "  starting server on :$PORT"
  python3 serve.py $PORT --allow-actions > /tmp/aura_test.log 2>&1 &
  sleep 4
fi

echo ""
echo "════ SERVER (concurrency + ollama proxy) ════"
printf "  %-20s " "test-search-automation"
python3 tests/test-search-automation.py | grep -oE "PASS [0-9]+" | tail -1
printf "  %-20s " "test-server-resilience"
python3 tests/test-server-resilience.py | grep -oE "PASS [0-9]+" | tail -1
printf "  %-20s " "test-windows-console"
python3 tests/test-windows-console.py | grep -oE "PASS [0-9]+" | tail -1
printf "  %-20s " "test-bridge-security"
python3 tests/test-bridge-security.py | grep -oE "PASS [0-9]+" | tail -1
printf "  %-20s " "test-server-concurrency"
python3 tests/test-server-concurrency.py | grep -oE "PASS [0-9]+" | tail -1
printf "  %-20s " "test-docgen"
python3 tests/test-docgen.py | grep -oE "PASS [0-9]+" | tail -1
printf "  %-20s " "test-devices"
python3 tests/test-devices.py | grep -oE "PASS [0-9]+" | tail -1
printf "  %-20s " "test-overlay-vdesk"
python3 tests/test-overlay-vdesk.py | grep -oE "PASS [0-9]+" | tail -1
printf "  %-20s " "test-capabilities"
python3 tests/test-capabilities.py | grep -oE "[0-9]+ passed" | tail -1
printf "  %-20s " "test-ollama-live"
python3 tests/test-ollama-live.py | grep -oE "PASS [0-9]+" | tail -1

echo ""
echo "════ BROWSER (needs playwright) ════"
for t in test-integration test-command-center test-guide test-desktop-ui test-body \
         test-new-features test-avatar-providers test-theming-memory test-vrm-mtoon test-face-recognition \
         test-vision-capabilities test-automation-ui test-screen-ui test-screen-panel \
         test-planner-height test-do-pipeline test-devconsole test-live-page test-privacy-ui \
         test-owner-live test-phone-page test-dwell-ui test-user-bugs-v2 test-sphere-ui; do
  printf "  %-20s " "$t"
  python3 "tests/$t.py" $PORT | grep -oE "PASS [0-9]+" | tail -1
done
printf "  %-20s " "browser-test"
python3 tests/browser-test.py $PORT | grep -oE "PASSED [0-9]+" | tail -1

echo ""
echo "════ LAYOUT (no overlapping text anywhere) ════"
printf "  %-20s " "find-overlaps"
python3 tests/find-overlaps.py $PORT | tail -1

# NOTE ON FIXTURES — each browser suite needs its own Ollama stand-in, and a
# stale stub on 11434 causes phantom failures. Kill stubs between groups:
#   pkill -f "fake-.*ollama"
#     test-screen-ui / test-live-page / test-screen-panel  -> fake-screen-ollama.py
#     test-task-e2e                                        -> fake-agent-ollama.py
#     test-do-pipeline / test-do-e2e / test-planner-height -> fake-real-ollama.py
#     test-guide / test-desktop-ui                         -> NO stub at all
#     test-do-e2e / test-task-e2e   also need: cp tests/fake-pyautogui.py /tmp/pyautogui.py
#                                             and PYTHONPATH=/tmp on serve.py
# test-setup is standalone: it starts its own server and its own stub on 11599.
