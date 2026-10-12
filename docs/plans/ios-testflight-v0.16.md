# iOS v0.16 TestFlight review and plan

Reviewed 2026-10-11 at `51999f23` (`chore: prepare v0.16.0 release`).
Status: first-beta fixes implemented; local tests, signed Release archive, and
distribution export pass. **Optio Agents `0.16.0 (1)` is in internal TestFlight**
(Apple ID `6821796813`, bundle ID `dev.optio.ios`). Upload with a team API key
succeeded; Apple reports processing `VALID` and internal state `IN_BETA_TESTING`.
The **Jon** group contains only Jon, whose tester state is `INVITED`. The beta
description and What to Test notes are saved. The App Store draft version is
`0.16.0`, with build 1 and 15 processed screenshots attached. Accepting the invitation and installing through
TestFlight remain phone-side steps; the previous direct development install
does not verify TestFlight installation.

The first release is **Jon only, through internal TestFlight, connected to his
own Optio server**. Later testers will connect to their own servers too. Keep
the existing native app and ship the release fixes before expanding its feature
set. Internal testing does not need the external TestFlight review/demo-server
work described below. See [Apple's internal testing workflow](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/).

## Implementation status

- App and widget version/build keys now expand the release build settings. Both
  carry privacy manifests; the app declares local-network permission and push.
  The ATS conflict and unprefixed shared Keychain group are fixed.
- Task, Job, and review history now recover across reconnects, page through long
  gaps, merge live rows by identity, and ignore stale requests after a view stops
  or switches runs. A real WebSocket handshake triggers recovery, including on
  the first connection. Terminal hello messages also wait for that handshake.
- Archive, export, and explicit upload commands and
  [the release guide](../../apps/ios/RELEASING.md) are in place. Injecting a failed
  build into the Makefile confirms its formatter no longer hides the failure.
- All **239 tests in OptioTests pass**, including 14 added history/handshake tests, with
  zero skips. Results: `/tmp/optio-v016-implementation-tests-4.xcresult`.
  Generated Swift types are in sync. `pnpm turbo test` passes (13 cached tasks).
  Plist lint, changed Markdown/YAML formatting, and `git diff --check` pass.
- The final unsigned device Release archive succeeds at
  `apps/ios/build/Optio-0.16.0-unsigned.xcarchive` (build log:
  `/tmp/optio-v016-release-final-2.log`). Both bundled executables report
  `0.16.0 (1)`, include their privacy manifests, and use the intended ATS settings.
  Primary and alternate icon sources are 1024×1024; default icons have no alpha.
  Normally signed simulator bundles expand the shared Keychain group to
  `3H2754M9U5.dev.optio.ios.shared`. Unsigned archives have no provisioning prefix
  and cannot validate production signing, push entitlements, or App Store upload.
- Physical-device push/widget sharing, UI acceptance, and live v0.16 server
  acceptance remain to be verified using the installed TestFlight build.
- After the paid membership activated, `make archive BUILD_NUMBER=1
ARCHIVE=build/Optio-0.16.0.xcarchive RELEASE_DD=build/ReleaseReview` succeeded.
  Both bundles have the correct signed App Group and shared Keychain
  entitlements; the app has `aps-environment=development` as expected before
  distribution export. `codesign --verify --deep --strict` passes. Archive log:
  `/tmp/optio-v016-paid-team-archive.log`.
- After refreshing Xcode's Apple ID sign-in, distribution export succeeded at
  `apps/ios/build/Optio-0.16.0-export/Optio.ipa`. The app has
  `aps-environment=production`; both executables have `get-task-allow=false`,
  matching shared Keychain/App Group entitlements, App Store profiles, correct
  versions, and privacy manifests. Their exported signatures verify. Export
  log: `/tmp/optio-v016-appstore-export-retry.log`.
- The development-signed Release app was installed directly on Jon's paired
  iPhone 15 Pro. Device inspection confirms `0.16.0 (1)` and a running Optio
  process after launch. This is a direct installation, not TestFlight; push
  delivery and widget behavior still need acceptance checks.
- Remote validation (`method=validation`, `destination=upload`) stopped before
  binary validation with `App Store Connect access for “John Wiggins” is
required`. This account-authentication attempt was superseded by the successful
  API-key upload below. Validation log:
  `/tmp/optio-v016-appstore-validation-retry.log`.
- Subsequent command-line validation and upload attempts still reported missing
  App Store Connect access. Jon's interactive Organizer attempt reached
  app-record creation and returned Apple's name-already-in-use error for
  **Optio**. Jon selected **Optio Agents** as the replacement; retain
  `dev.optio.ios` and the **Optio** Home Screen name. This metadata change needs
  no rebuild.
- Organizer successfully created **Optio Agents** at 2026-10-12 03:36:29 UTC:
  HTTP 201, Apple ID `6821796813`, bundle ID/SKU `dev.optio.ios`, locale `en-US`.
  The immediately following lookup returned an empty app list, producing
  `DistributionAppRecordProviderError.missingApp` (the displayed error 0).
  Propagation delay is the likely explanation, not a confirmed Apple diagnosis.
  [Existing app](https://appstoreconnect.apple.com/apps/6821796813). A subsequent command-line upload still failed
  at account access before sending the binary; log:
  `/tmp/optio-v016-created-record-upload.log`.
- After Jon's latest sign-in, upload still failed before sending the binary
  (`/tmp/optio-v016-first-upload-signed-in.log`). GUI automation is unavailable;
  an App Store Connect team API key with App Manager access then enabled direct
  upload of the exported IPA with `altool`, without rebuilding. Upload succeeded
  with no errors, and Apple processed build 1 successfully. The internal Jon
  group has the build and exactly one invited tester. No external group or
  public invitation link was created.
- The current simulator build succeeds. The dedicated showcase lab on port 4967
  supplies fictional data for native screenshots, using
  `apps/ios/scripts/capture-store-screenshots.mjs`. Capture output and the beta
  description/test notes are in `apps/ios/build/TestFlightScreenshots/0.16.0/`.
  The script records version/build provenance and captures JPEGs without alpha.
  All 15 images were visually reviewed and verified: five each at 1206×2622,
  1320×2868, and 2064×2752. The package is
  `apps/ios/build/TestFlightScreenshots/Optio-Agents-0.16.0-screenshots.zip`.
  All 15 uploaded to the English (U.S.) App Store draft and reached `COMPLETE`;
  remote file checksums match the local images. The draft remains
  `PREPARE_FOR_SUBMISSION`.
- Device inspection found no TestFlight app on Jon's iPhone. Opening its App
  Store page was denied because the phone was locked. Installing TestFlight
  and accepting the invitation require interaction on the phone;
  the installed Optio `0.16.0 (1)` remains the direct development install.

The findings below record the original review baseline and rationale.

## Verified baseline

- Xcode 27.0 (`27A266a`) and XcodeGen are installed. Deployment target is iOS 17.
- Regenerated the project and ran `OptioTests` on the iPhone 17e / iOS 26.4
  simulator: **225 tests passed** with normal simulator signing.
- An initial unsigned test run failed only in Keychain/ServerRegistry tests
  (13 failure assertions). Restoring normal signing made the entire suite pass;
  do not treat that first run as evidence of an app regression.
- `bash scripts/check-swift-types.sh` passed. SwiftTerm resolves to the pinned
  `1.20.0`; preserve that pin for this release.
- A clean **Release archive for generic iOS succeeded** with signing disabled:
  `/tmp/Optio-v016-review.xcarchive`. Inspection confirms the app and widget both
  report `1.0 (1)` and contain no privacy manifest. This archive proves device
  compilation/packaging only; it cannot be uploaded unsigned. A signed
  distribution archive and App Store Connect validation are still required.
- The v0.16 [CI run](https://github.com/jonwiggins/optio/actions/runs/38161340260)
  has finished with API E2E and Web E2E failures. In API E2E, 137 tests
  passed and one failed in `scale-out-runs.e2e.test.ts`, the ten-runs/server-kill
  case. It timed out waiting for an agent to become idle, reporting provisioning
  with no turns or pods. Root cause is not established; track this as a separate
  server release gate. Web E2E finished with 111 passed, one flaky Local-session
  test, and one failed pod-session sidebar test: the mobile sidebar was hidden
  after dismissing its workspace menu (`sidebar.spec.ts:225`). Neither failure
  has been fixed in this iOS change. CI checks generated Swift types but does not compile or
  test iOS. The container release workflows do not upload a TestFlight app.
- Locally, one Apple Development signing identity is available. This does not
  establish whether the newly paid membership is active or distribution signing
  is provisioned. App Store Connect account state was not inspected.

Test results: `/tmp/optio-v016-signed-unit-review.xcresult`.
Archive check log: `/tmp/optio-v016-archive-review.log`.
The full UI test suite, physical push delivery, widget credential sharing, and
live v0.16 server acceptance have not been verified in this review.

## Findings and required changes

### 1. Upload readiness: version, privacy manifest, and signing

[`project.yml`](../../apps/ios/project.yml) still sets marketing version `0.1.0`
and build `1`, while XcodeGen's generated plists hardcode `1.0` and `1`. The
Release archive actually reports **`1.0 (1)`** for both app and widget, so merely
bumping `MARKETING_VERSION` will not fix the delivered version. Explicitly wire
`CFBundleShortVersionString` to `$(MARKETING_VERSION)` and `CFBundleVersion` to
`$(CURRENT_PROJECT_VERSION)` in both targets' generated info properties. Set
`0.16.0`, using a fresh build number for each upload. Keep `project.yml` as the
source of truth because XcodeGen rewrites the generated plist and entitlement
files.

There is no `PrivacyInfo.xcprivacy` in the app or widget source. Both use
`UserDefaults`, including an App Group suite
([`SharedCredentials.swift`](../../apps/ios/Shared/SharedCredentials.swift)).
Add manifests to the shipped bundles describing their actual required-reason
API use. Audit the resolved SwiftTerm sources and the archive's privacy report
too; declaring the app's preferences alone is not a dependency audit. Apple
requires declarations for these APIs when uploading to App Store Connect:
[required-reason API guidance](https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api).

The app entitlement contains App Groups and Keychain Sharing, but no
`aps-environment`. Paying for membership does not add that declaration to this
repository. Enable Push Notifications for the app identifier and preserve the
capability in XcodeGen. Verify the exported distribution app has
`aps-environment=production`; verify both targets' App Group and keychain
entitlements match their provisioning profiles.

### 2. Connection setup: local-network permission and ATS conflict

The app lacks `NSLocalNetworkUsageDescription`. Add a clear explanation for
connecting to the user's Optio server on the local network. Apple documents
that outgoing local TCP connections require local-network access; the usage
description belongs in the containing app's plist:
[local-network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).

Both app and extension set `NSAllowsArbitraryLoads` together with
`NSAllowsLocalNetworking`. On supported iOS versions the latter makes the
former ineffective. Thus the README's claim that arbitrary plain-HTTP tailnet
hostnames are allowed does not follow from the actual configuration. This is a
configuration finding, not a reproduced device connection failure.
[Apple's ATS precedence rules](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CocoaKeys.html).

Preserve user-selected self-hosted server support: make the ATS configuration
consistent in both targets, keep HTTPS as the default, and document why HTTP is
supported for user-managed servers. Validate named HTTP tailnet hosts, local IP
addresses, and HTTPS independently. Do not silently remove an existing supported
connection mode. The local-network permission is separate from ATS.

### 3. Reliability: missed logs are not recovered after reconnect

In [`TaskLogStream.swift`](../../apps/ios/Optio/Features/Run/Tasks/TaskLogStream.swift)
and [`RunLogStream.swift`](../../apps/ios/Optio/Features/Run/Jobs/RunLogStream.swift),
`.opened` only changes the connected flag; REST history loads on initial start.
Both discard `catchUp` frames. After a network interruption or API restart,
persisted lines emitted during the gap are therefore missing from the open
view. The shared run stream affects Job runs and PR reviews. The web's v0.16
[`log-resync.ts`](../../apps/web/src/lib/log-resync.ts) already addresses this.

Port that behavior before the first daily-use beta: fetch missed history after
reconnect, merge concurrent live lines without duplicates, paginate beyond the
history limit, and cancel/ignore stale fetches when a view stops or changes run.
Refresh run state as well when its final transition happened during the outage.
Keep existing entries visible when the recovery request fails.

### 4. Release workflow can hide build failures

[`Makefile`](../../apps/ios/Makefile) pipes `xcodebuild` through a formatter
without `pipefail`. The formatter can exit successfully after a failed build
or test. Fix failure propagation before relying on these commands as a gate.
Add repeatable archive/export commands and document build numbering. A macOS
CI build/test job is useful follow-up; the first upload can use Xcode Organizer.

### 5. New server features are not yet native screens

The iOS Insights tab still has Analytics / Costs / Activity / Cluster and calls
`/api/analytics/costs`. It does not expose v0.16 Usage rankings, trends, and
monthly budgets. Work has All / Reviews / Inbox, without Trigger History.

These are feature gaps, not proven compatibility failures: the server explicitly
preserves the legacy Costs contract ([usage docs](../usage.md)). After the first
install, add native Usage and Trigger History, including ownership/role filtering
and dispatch retry permissions. Check budget-paused work and its reason on the
phone during release acceptance; do not require a full budget editor to ship.

The Release archive also reports warnings for the notification delegate's Swift
6 concurrency conformance, deprecated App Intent confirmation overloads, and a
weak capture in `PushRegistrar`. They did not fail the current Swift 5-mode
build; address them separately from the upload blockers.

## Implementation and release sequence

1. **Prepare the app.** Version/build metadata, privacy manifests, persistent
   push capability, local-network description, consistent HTTP handling, and
   Makefile failure propagation. Update the iOS README's outdated Sessions paths
   and add a TestFlight release recipe. Regenerate and inspect both bundles.
2. **Repair log recovery.** Implement the reconnect behavior above and add focused
   tests for a gap, overlapping history/live rows, a long gap, failed recovery,
   and leaving the screen while recovery is in flight.
3. **Configure Apple distribution.** Verify membership activation and Xcode's
   paid team (the project currently names `3H2754M9U5`). Register/verify
   `dev.optio.ios`, `dev.optio.ios.widgets`, and `group.dev.optio.ios`; enable the
   relevant capabilities and create the App Store Connect app record. Obtain
   distribution signing through Xcode. These account steps remain unverified.
4. **Archive and upload.** Run tests with simulator signing, then make a signed
   Release archive for a generic iOS device. Validate in Organizer, inspect the
   privacy report, versions, icons, embedded widget, and entitlements, then
   upload with App Store Connect distribution. Use the normal distribution route
   so the build can later be considered for external testing. Resolve export
   compliance; `ITSAppUsesNonExemptEncryption=false` is already present, and its
   accuracy must be retained as dependencies change.
5. **Install through internal TestFlight.** Create an internal group containing
   Jon's App Store Connect account, attach the processed build, and install it
   on the phone. Pair with the real server using its URL and a PAT. Production
   APNs setup can follow immediately on that trusted server.

For Jon's own server, store the APNs key in the existing server secret mechanism
from [iOS push setup](../ios-push.md), never in the app or repository. TestFlight
tokens use the production environment; the client already reports its token
environment. Confirm real registration and delivery rather than relying on the
presence of the capability. Check current key environment/topic settings when
creating it: [Apple APNs key setup](https://developer.apple.com/help/account/keys/create-a-private-key/).

## Acceptance on the installed TestFlight build

- Fresh pairing, invalid PAT, server offline, app relaunch, and server switching.
- HTTPS and the intended HTTP/Tailscale connection; allow/deny local-network
  access and recover through Settings.
- Create work, send a Local chat message, use the terminal, inspect a PR/review,
  and see a recurring definition. Use disposable work for mutation checks.
- Drop and restore connectivity while logs are arriving; show every persisted
  line once and recover the final state. Repeat across a server restart.
- App and widget read the same paired server/token after relaunch. Verify
  removing a server clears access and updates widgets. The bare access-group
  string in `SharedCredentials` differs from the prefixed signing entitlement;
  explicitly verify cross-process sharing rather than inferring it from the
  same-process Keychain unit tests.
- Send the server's test push, tap it, receive a needs-you notification, and
  exercise a Live Activity action with the app backgrounded. Check the server
  lists the token as production. Verify Watch mirroring if a Watch is available.
- Check appearance, large text, keyboard/composer, and reconnect behavior on
  the actual phone. Retain an iPad smoke check because the app declares support.

## Later: invited testers on their own servers

Broader testing adds an external TestFlight review, beta description, feedback
contact, and working reviewer access. Provide a maintained demo server and test
credentials before that review; the current first-run screen requires a URL
and PAT. Improve onboarding so Tailscale is explained as optional, validate
HTTP(S) URLs, and hide development-only advice in Release. Publish accurate
privacy/support information reflecting the actual data flow.
[Apple's beta test information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information/).

Independent operators cannot send notifications for Jon's app using unrelated
Apple teams' keys. Keep the publisher APNs key on trusted infrastructure.
Before promising push for arbitrary self-hosted servers, design an authenticated
publisher-operated relay with device/server binding and abuse controls, or
clearly ship that beta without remote push on those servers. This larger design
is not required for Jon's own trusted server and is not part of the first upload.
