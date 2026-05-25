declare global {
  const REDCODE_VERSION: string
  const REDCODE_CHANNEL: string
}

export const InstallationVersion = typeof REDCODE_VERSION === "string" ? REDCODE_VERSION : "local"
export const InstallationChannel = typeof REDCODE_CHANNEL === "string" ? REDCODE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local" || InstallationChannel === "dev"
