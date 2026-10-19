import { Component, Show, createEffect, createMemo, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import * as QRCode from "qrcode"
import { Button } from "@redcode-ai/ui/button"
import { Select } from "@redcode-ai/ui/select"
import { showToast } from "@redcode-ai/ui/toast"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { mobilePairingPayload } from "./mobile-pairing-payload"
import { SettingsList, SettingsRow } from "./settings-list"

export const SettingsMobileCompanion: Component<{
  directory?: string
  sessionID?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const [store, setStore] = createStore({
    status: null as Awaited<ReturnType<NonNullable<typeof platform.getMobileGatewayStatus>>> | null,
    host: "127.0.0.1",
    busy: false,
    qr: undefined as string | undefined,
  })

  const hosts = createMemo(() => store.status?.hosts ?? [])
  const hostOptions = createMemo(() =>
    hosts().map((host) => ({ value: host.address, label: `${host.name} (${host.address})` })),
  )
  const info = createMemo(() => store.status?.info ?? null)
  const devices = createMemo(() => store.status?.devices ?? [])
  const running = createMemo(() => store.status?.running ?? false)
  const pairingPayload = createMemo(() => {
    const current = info()
    return current ? mobilePairingPayload(current) : undefined
  })

  const fail = (error: unknown) => {
    const description = error instanceof Error ? error.message : String(error)
    showToast({ title: language.t("common.requestFailed"), description })
  }

  const refresh = async () => {
    if (!platform.getMobileGatewayStatus) return
    const status = await platform.getMobileGatewayStatus()
    setStore("status", status)
    if (!status.hosts.some((host) => host.address === store.host)) {
      setStore("host", status.hosts[0]?.address ?? "")
    }
  }

  onMount(() => {
    void refresh().catch(fail)
  })

  const act = (operation: () => Promise<unknown>) => {
    setStore("busy", true)
    void operation()
      .then(refresh)
      .catch(fail)
      .finally(() => setStore("busy", false))
  }

  const start = () => {
    const startMobileGateway = platform.startMobileGateway
    const directory = props.directory
    const sessionID = props.sessionID
    if (!startMobileGateway || !directory || !sessionID) return
    act(() => startMobileGateway(store.host, directory, sessionID))
  }

  const stop = () => {
    const stopMobileGateway = platform.stopMobileGateway
    if (!stopMobileGateway) return
    act(async () => {
      await stopMobileGateway()
      showToast({ variant: "success", title: language.t("settings.mobileGateway.stopSuccess") })
    })
  }

  const refreshCode = () => {
    const refreshMobileGatewayPairingCode = platform.refreshMobileGatewayPairingCode
    if (!refreshMobileGatewayPairingCode) return
    act(async () => {
      await refreshMobileGatewayPairingCode()
      showToast({ variant: "success", title: language.t("settings.mobileGateway.codeRefreshed") })
    })
  }

  const refreshDevices = () => act(() => Promise.resolve())

  const revoke = (id: string) => {
    const revokeMobileGatewayDevice = platform.revokeMobileGatewayDevice
    if (!revokeMobileGatewayDevice) return
    act(async () => {
      if (!(await revokeMobileGatewayDevice(id))) throw new Error(language.t("settings.mobileGateway.deviceNotFound"))
    })
  }

  let qrGeneration = 0
  createEffect(() => {
    const payload = pairingPayload()
    const generation = ++qrGeneration
    setStore("qr", undefined)
    if (!payload) {
      return
    }
    void QRCode.toDataURL(payload, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 256,
      color: { dark: "#111111", light: "#ffffff" },
    })
      .then((qr) => {
        if (generation === qrGeneration) setStore("qr", qr)
      })
      .catch(fail)
  })

  return (
    <Show when={platform.platform === "desktop" && !!platform.getMobileGatewayStatus}>
      <div class="flex flex-col gap-1">
        <h3 class="text-14-medium text-text-strong pb-2">{language.t("settings.mobileGateway.title")}</h3>
        <p class="text-12-regular text-text-weak pb-2">{language.t("settings.mobileGateway.description")}</p>
        <p class="text-12-regular text-text-weak pb-2">{language.t("settings.mobileGateway.networkWarning")}</p>

        <SettingsList>
          <Show when={!running()}>
            <SettingsRow
              title={language.t("settings.mobileGateway.host")}
              description={language.t("settings.mobileGateway.hostDescription")}
            >
              <Select
                options={hostOptions()}
                current={hostOptions().find((option) => option.value === store.host)}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => option && setStore("host", option.value)}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{ "min-width": "220px" }}
                disabled={store.busy || hostOptions().length === 0}
              />
            </SettingsRow>
            <SettingsRow
              title={language.t("settings.mobileGateway.start")}
              description={
                props.sessionID
                  ? language.t("settings.mobileGateway.sessionScope")
                  : language.t("settings.mobileGateway.sessionRequired")
              }
            >
              <Button
                size="small"
                variant="secondary"
                disabled={store.busy || !props.directory || !props.sessionID || !store.host}
                onClick={start}
              >
                {language.t("settings.mobileGateway.start")}
              </Button>
            </SettingsRow>
          </Show>

          <Show when={running() && info()}>
            {(current) => (
              <>
                <SettingsRow
                  title={language.t("settings.mobileGateway.qrTitle")}
                  description={language.t("settings.mobileGateway.qrDescription")}
                >
                  <Show
                    when={store.qr}
                    fallback={<span class="text-12-regular text-text-weak">{language.t("settings.mobileGateway.qrPreparing")}</span>}
                  >
                    {(qr) => (
                      <img
                        src={qr()}
                        alt={language.t("settings.mobileGateway.qrAlt")}
                        width="240"
                        height="240"
                        class="rounded-md bg-white p-2"
                      />
                    )}
                  </Show>
                </SettingsRow>
                <SettingsRow
                  title={language.t("settings.mobileGateway.url")}
                  description={language.t("settings.mobileGateway.urlDescription")}
                >
                  <code class="select-all text-12-regular text-text-strong break-all">{current().url}</code>
                </SettingsRow>
                <SettingsRow
                  title={language.t("settings.mobileGateway.code")}
                  description={language.t("settings.mobileGateway.codeDescription")}
                >
                  <div class="flex flex-col gap-1">
                    <code class="select-all text-14-medium text-text-strong">{current().pairingCode}</code>
                    <span class="text-11-regular text-text-weak">
                      {language.t("settings.mobileGateway.expires", {
                        time: new Date(current().pairingExpiresAt).toLocaleTimeString(),
                      })}
                    </span>
                  </div>
                </SettingsRow>
                <SettingsRow
                  title={language.t("settings.mobileGateway.fingerprint")}
                  description={language.t("settings.mobileGateway.fingerprintDescription")}
                >
                  <code class="select-all text-11-regular text-text-strong break-all">{current().fingerprint}</code>
                </SettingsRow>
                <SettingsRow
                  title={language.t("settings.mobileGateway.devices")}
                  description={language.t("settings.mobileGateway.devicesDescription")}
                >
                  <div class="flex flex-col gap-2">
                    <Show
                      when={devices().length > 0}
                      fallback={<span class="text-12-regular text-text-weak">{language.t("settings.mobileGateway.noDevices")}</span>}
                    >
                      {devices().map((device) => (
                        <div class="flex items-center justify-between gap-3">
                          <span class="text-12-regular text-text-strong">{device.name}</span>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={store.busy}
                            onClick={() => revoke(device.id)}
                          >
                            {language.t("settings.mobileGateway.revoke")}
                          </Button>
                        </div>
                      ))}
                    </Show>
                  </div>
                </SettingsRow>
                <SettingsRow
                  title={language.t("settings.mobileGateway.refreshCode")}
                  description={language.t("settings.mobileGateway.refreshCodeDescription")}
                >
                  <Button size="small" variant="secondary" disabled={store.busy} onClick={refreshCode}>
                    {language.t("settings.mobileGateway.refreshCode")}
                  </Button>
                </SettingsRow>
                <SettingsRow
                  title={language.t("settings.mobileGateway.refreshDevices")}
                  description={language.t("settings.mobileGateway.refreshDevicesDescription")}
                >
                  <Button size="small" variant="secondary" disabled={store.busy} onClick={refreshDevices}>
                    {language.t("settings.mobileGateway.refreshDevices")}
                  </Button>
                </SettingsRow>
                <SettingsRow
                  title={language.t("settings.mobileGateway.stop")}
                  description={language.t("settings.mobileGateway.stopDescription")}
                >
                  <Button size="small" variant="ghost" disabled={store.busy} onClick={stop}>
                    {language.t("settings.mobileGateway.stop")}
                  </Button>
                </SettingsRow>
              </>
            )}
          </Show>
        </SettingsList>
      </div>
    </Show>
  )
}
