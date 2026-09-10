#!/usr/bin/env bash
# AURA :: full verification suite — LOUD accounting, no silent greens.
#
# Every suite's PASS *and* FAIL counts are shown; any FAIL, crash, missing
# result, or nonzero exit lands the suite in FAILED_SUITES, printed at the
# end. The script exits nonzero unless everything passes, and always writes
# aura/STATUS.json via tests/write-status.py (even on failure).
#
# NOTE: deliberately NO `set -e` — one crashing suite must not silently
# skip the rest of the battery.
cd "$(dirname "$0")/.."

RUNLOG="$(mktemp)"
trap 'rm -f "$RUNLOG"' EXIT
PASS_TOTAL=0
FAIL_TOTAL=0
FAILED_SUITES=()

# run NAME CMD... — for suites printing "PASS n  FAIL m"
run() {
  local name="$1"; shift
  printf "  %-22s " "$name"
  local out rc line p f
  out="$("$@" 2>&1)"; rc=$?
  line="$(printf '%s\n' "$out" | sed 's/\x1b\[[0-9;]*m//g' | grep -oE 'PASS [0-9]+( +FAIL [0-9]+)?' | tail -1)"
  if [ -z "$line" ]; then
    echo "NO RESULT (rc=$rc) -- output tail:"
    printf '%s\n' "$out" | tail -3 | sed 's/^/      /'
    FAILED_SUITES+=("$name(NO RESULT,rc=$rc)")
    FAIL_TOTAL=$((FAIL_TOTAL + 1))
    return
  fi
  echo "$line"
  p="$(printf '%s' "$line" | grep -oE 'PASS [0-9]+' | grep -oE '[0-9]+')"
  f="$(printf '%s' "$line" | grep -oE 'FAIL [0-9]+' | grep -oE '[0-9]+')"
  PASS_TOTAL=$((PASS_TOTAL + ${p:-0}))
  FAIL_TOTAL=$((FAIL_TOTAL + ${f:-0}))
  if [ "$rc" -ne 0 ] || [ "${f:-0}" -ne 0 ]; then
    FAILED_SUITES+=("$name($line,rc=$rc)")
  fi
}

# run_raw NAME PATTERN CMD... — for suites with their own summary format
# (counts the number as passes; a nonzero exit or missing line fails it)
run_raw() {
  local name="$1" pat="$2"; shift 2
  printf "  %-22s " "$name"
  local out rc line n
  out="$("$@" 2>&1)"; rc=$?
  line="$(printf '%s\n' "$out" | grep -oE "$pat" | tail -1)"
  if [ -z "$line" ]; then
    echo "NO RESULT (rc=$rc)"
    FAILED_SUITES+=("$name(NO RESULT,rc=$rc)")
    FAIL_TOTAL=$((FAIL_TOTAL + 1))
    return
  fi
  echo "$line"
  n="$(printf '%s' "$line" | grep -oE '[0-9]+' | tail -1)"
  PASS_TOTAL=$((PASS_TOTAL + ${n:-0}))
  if [ "$rc" -ne 0 ]; then
    FAILED_SUITES+=("$name($line,rc=$rc)")
  fi
}

echo "==== NODE (no browser needed) ===="
for t in test-architecture test-core test-providers test-actions \
         test-live test-desktop test-router test-models test-voice-loop \
         test-gesture-wave test-desktop-tools test-vision-embeddings test-screen-agent \
         test-gestures-cursor test-task-agent test-runtime test-privacy-guard test-dwell \
         test-doc-agent test-doc-resilience test-sphere \
         test-commander test-memory-recall test-avatar-import test-verify-loop \
         test-feature-registry test-feature-apps test-controls test-multi-wake \
         test-command-interpreter test-device-voice test-resizers \
         test-proactive test-wake-engine; do
  run "$t" node "tests/$t.mjs"
done

run test-module-parse node --experimental-vm-modules tests/test-module-parse.mjs

PORT=8000
if ! curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/"; then
  echo ""
  echo "  starting server on :$PORT"
  python3 serve.py "$PORT" --allow-actions > /tmp/aura_test.log 2>&1 &
  sleep 4
fi

echo ""
echo "==== SERVER ===="
run test-wake-service python3 tests/test-wake-service.py
run test-search-automation python3 tests/test-search-automation.py
run test-server-resilience python3 tests/test-server-resilience.py
run test-windows-console python3 tests/test-windows-console.py
run test-bridge-security python3 tests/test-bridge-security.py
run test-server-concurrency python3 tests/test-server-concurrency.py
run test-docgen python3 tests/test-docgen.py
run test-features python3 tests/test-features.py
run test-terminal-cli python3 tests/test-terminal-cli.py
run test-controls python3 tests/test-controls.py
run test-usage python3 tests/test-usage.py
run test-devices python3 tests/test-devices.py
run test-overlay-vdesk python3 tests/test-overlay-vdesk.py
run_raw test-capabilities '[0-9]+ passed' python3 tests/test-capabilities.py
run test-ollama-live python3 tests/test-ollama-live.py

echo ""
echo "==== BROWSER (needs playwright) ===="
for t in test-integration test-command-center test-guide test-desktop-ui test-body \
         test-new-features test-avatar-providers test-theming-memory test-vrm-mtoon test-face-recognition \
         test-vision-capabilities test-automation-ui test-screen-ui test-screen-panel \
         test-planner-height test-do-pipeline test-devconsole test-live-page test-privacy-ui \
         test-owner-live test-phone-page test-dwell-ui test-user-bugs-v2 test-sphere-ui; do
  run "$t" python3 "tests/$t.py" "$PORT"
done
run_raw browser-test 'PASSED [0-9]+' python3 tests/browser-test.py "$PORT"

echo ""
echo "==== LAYOUT (no overlapping text anywhere) ===="
run_raw find-overlaps 'overlap[^:]*: [0-9]+|OK|FAIL' python3 tests/find-overlaps.py "$PORT"

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

echo ""
echo "======== SUMMARY ========"
echo "  asserts: PASS $PASS_TOTAL  FAIL $FAIL_TOTAL   suites failed: ${#FAILED_SUITES[@]}"
if [ "${#FAILED_SUITES[@]}" -gt 0 ]; then
  printf '  FAIL %s\n' "${FAILED_SUITES[@]}"
fi

# Always record the battery outcome (green OR red) — the hook.
if [ "${#FAILED_SUITES[@]}" -eq 0 ]; then
  python3 tests/write-status.py --pass "$PASS_TOTAL" --fail "$FAIL_TOTAL" --failed none
else
  python3 tests/write-status.py --pass "$PASS_TOTAL" --fail "$FAIL_TOTAL" --failed "${FAILED_SUITES[@]}"
fi

[ "${#FAILED_SUITES[@]}" -eq 0 ]
