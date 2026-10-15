#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/android"
# Match CI, including feature-module tests that consume generated models.
if [[ -z "${JAVA_HOME:-}" && -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
if [[ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" && -d "$HOME/Library/Android/sdk" ]]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi
./gradlew assembleDebug testDebugUnitTest :core:model:test :core:network:test --stacktrace
