---
name: harmonyos-android-compat
description: Use when porting or validating an Android app on Huawei HarmonyOS phones, especially HarmonyOS 6+ with 卓易通; prefer APK reuse and compatibility validation before native HarmonyOS work.
---

# HarmonyOS Android compatibility workflow

Use this skill for a Huawei phone target when the goal is to get an existing Android app running quickly. This is a validation-and-adaptation workflow, not a promise that every Android API works inside 卓易通.

## Choose an available route

Record the exact device model, HarmonyOS version and build, orientation, APK identity, and which compatibility paths are actually available on the target.

1. **Direct APK path (only when exposed by the target device)** — install the existing APK through the device's Android compatibility support.
2. **卓易通 sandbox path (when installed and available)** — install the existing APK inside 卓易通. This is the preferred first attempt on HarmonyOS 6+ devices.
3. **Native HarmonyOS port** — consider only when the APK paths cannot meet the required workflow, or when native HarmonyOS application/system-service integration is required.

Do not assume any compatibility path exists on every model or OS build. Do not start an ArkUI rewrite before the available APK paths have been tested.

Give each route an explicit stop condition:

- **Direct APK path:** stop when installation, launch, and the requested core smoke test pass. Do not continue into the sandbox or a native port just to explore another route; continue only if the user's requirement remains unverified.
- **卓易通 sandbox path:** stop when the requested core smoke test passes and report the result as sandbox-only. Do not infer that native HarmonyOS apps or system-wide traffic work.
- **Native HarmonyOS port:** implement only the missing required native capability; stop when that capability and the requested workflow are verified. Do not expand it into a full port without a separate requirement.
- If a path is unavailable or fails, record the evidence and blocker before considering the next available route. Do not report “unsupported” when the path itself was unavailable.

## Reuse the Android artifact

- Check for an existing APK before rebuilding.
- Reusing the APK from a tablet is valid when the package is the same; app data, permissions, VPN authorization, and subscription state do not transfer automatically.
- Prefer an `arm64-v8a` or universal APK. Native sidecars must be packaged in the platform-supported native-library location; do not assume an executable copied into app data can run.
- Keep the package ID and signing key stable for updates.
- If a same-name file is copied through MTP and silently remains old, copy the new APK under a unique filename instead of deleting the old one.

## Connect and transfer

MTP file transfer is not a debug connection.

- Android devices normally appear through `adb devices -l`.
- HarmonyOS devices may expose an `HDC Interface` and require `hdc list targets`.
- If File Explorer sees the phone but ADB is empty, do not diagnose that as an app failure. Enable USB/HDC debugging and check whether `adb` or `hdc` is actually installed.
- When HDC is unavailable, MTP is sufficient for copying an APK into `内部存储/Download`; installation and permission prompts still require a physical tap.
- Verify the copied file size or checksum before installing. Do not trust a successful-looking MTP copy with no verification.

## Install and validate

Install the APK through 卓易通 when the target is a sandboxed HarmonyOS phone. Allow unknown-app installation only for the intended installer.

Run the common smoke test:

1. Launch the app.
2. Exercise the main data import/create flow.
3. Confirm the main runtime or native sidecar starts.
4. Restart the app and verify data persistence.
5. Background and resume the app once.
6. Check permissions, keyboard input, scrolling, and touch targets.

Add feature-specific checks:

- **VPN/network app:** establish VPN/TUN, select a node, test an external domain, and separately test an app inside versus outside 卓易通. A successful sandbox test does not prove that native HarmonyOS apps are routed.
- **Music app:** background playback, audio focus, media notification/session, lock-screen controls, interruption and resume.
- **Notes app:** keyboard, file/storage permission, save/reopen, large text, rotation, and crash-safe persistence.

## Output contract

Use the same report shape for every attempted route so results can be compared:

- **Route:** direct APK, 卓易通 sandbox, or native HarmonyOS; mark unavailable routes as unavailable.
- **Result:** pass, fail, unavailable, or not run, scoped to the exact tested workflow.
- **Evidence:** device model; HarmonyOS version/build; APK package, version, and filename or checksum; build command/result (or “reused existing APK”); smoke-test steps and results; relevant logs or screenshots.
- **Remaining risk:** explicitly list untested paths or capabilities, such as native HarmonyOS app traffic.
- **Next action:** stop, test another available route, or escalate for a specific missing native capability.

Persist the same device, OS, APK, build, and test details in project memory or a test log. Do not claim “full HarmonyOS support” when only the Android sandbox path was verified.

## Narrow-phone UI adaptation

卓易通 may report a desktop-like logical viewport, so a normal CSS breakpoint can be unreliable. Detect the Android runtime as well as measuring the viewport.

For phone-only changes:

- Force a compact icon navigation rail or another reachable mobile navigation pattern.
- Keep touch targets at least roughly 44–52 CSS px.
- Make the main flex child `min-width: 0`; remove desktop minimum widths from the mobile path.
- Use single-column cards/forms when the phone content width is narrow.
- Set `overflow-x: hidden` only after fixing the layout; do not use horizontal clipping to hide unusable controls.
- Add compact page-header padding and preserve a vertical scroll region.
- Keep desktop and tablet layouts unchanged unless the evidence shows they need the same fix.
- Verify with a real screenshot and real taps, not only a dispatched click or a nominal `rect`.

The responsive implementation should be platform-scoped when possible, for example an `.android` root class or an explicit mobile layout mode. Avoid persisting a phone-only navigation preference into the desktop/tablet configuration.

## Escalate to native HarmonyOS only when needed

If the APK paths cannot meet the required workflow or native-system integration is a requirement:

- Preserve portable business logic and Rust/C/C++ cores where practical.
- Reuse the web UI in ArkWeb if that is cheaper than a full ArkUI rewrite.
- Replace the Tauri bridge with an ArkTS/Native bridge.
- Replace Android-specific services such as `VpnService` with the corresponding HarmonyOS extension/API and verify whether the required file descriptor or system capability is actually exposed.
- Treat `VpnExtensionAbility` as an API building block, not a drop-in mihomo/RedClash port.

Do not mix a compatibility-layer fix with a native-port rewrite in the same change.

## Reference outcome

The workflow was validated on one specific target: a Huawei Enjoy 90 Pro Max running HarmonyOS 6.1. The existing Android APK ran through 卓易通, received the phone-specific compact navigation and single-column home layout, imported a subscription, established TUN, and reached Google. Native HarmonyOS app traffic was not separately certified.

This is an example, not a precedent or compatibility guarantee. Do not generalize the result to another device model, OS build, APK, or route without repeating validation on that target.
