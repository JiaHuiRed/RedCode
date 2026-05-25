/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://redcode.dev",

  // GitHub
  github: {
    repoUrl: "https://github.com/JiaHuiRed/RedCode",
    starsFormatted: {
      compact: "160K",
      full: "160,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/RedCode",
    discord: "https://discord.gg/RedCode",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "900",
    commits: "13,000",
    monthlyUsers: "7.5M",
  },
} as const
