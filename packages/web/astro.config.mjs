// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import solidJs from "@astrojs/solid-js"
import cloudflare from "@astrojs/cloudflare"
import theme from "toolbeam-docs-theme"
import config from "./config.mjs"
import { rehypeHeadingIds } from "@astrojs/markdown-remark"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import { spawnSync } from "child_process"

// https://astro.build/config
export default defineConfig({
  site: config.url,
  base: "/docs",
  output: "server",
  adapter: cloudflare({
    imageService: "passthrough",
  }),
  devToolbar: {
    enabled: false,
  },
  server: {
    host: "0.0.0.0",
  },
  markdown: {
    rehypePlugins: [rehypeHeadingIds, [rehypeAutolinkHeadings, { behavior: "wrap" }]],
  },
  build: {},
  integrations: [
    configSchema(),
    solidJs(),
    starlight({
      title: "RedCode",
      defaultLocale: "root",
      locales: {
        root: {
          label: "English",
          lang: "en",
          dir: "ltr",
        },
        // 260805 Red 文档语种收敛为中日英三种（见 src/i18n/locales.ts）
        ja: {
          label: "日本語",
          lang: "ja-JP",
          dir: "ltr",
        },
        "zh-cn": {
          label: "简体中文",
          lang: "zh-CN",
          dir: "ltr",
        },
      },
      // 260903 cc 指向 .ico 而不是 .svg。81adb45a 把 favicon 一套换成看板娘「赤」时
      //   删掉了 SVG 那一档（插画没法做成矢量），但这里还指着它，于是文档站**每一页**
      //   都在请求一个不存在的文件。
      //   注意不能直接删掉这一行：Starlight 的 favicon 默认值是 "/favicon.svg"
      //   （schemas/favicon.ts 的 .default()），删了只会把 404 从 favicon-v3.svg 挪到
      //   favicon.svg，而那个链接同样是断的。必须显式指向一个真实存在的文件。
      favicon: "/favicon-v3.ico",
      head: [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: "/favicon-v3.ico",
            sizes: "32x32",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            href: "/favicon-96x96-v3.png",
            sizes: "96x96",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: "/apple-touch-icon-v3.png",
            sizes: "180x180",
          },
        },
      ],
      lastUpdated: true,
      expressiveCode: { themes: ["github-light", "github-dark"] },
      social: [
        { icon: "github", label: "GitHub", href: config.github },
        { icon: "discord", label: "Discord", href: config.discord },
      ],
      editLink: {
        baseUrl: `${config.github}/edit/dev/packages/web/`,
      },
      markdown: {
        headingLinks: false,
      },
      customCss: ["./src/styles/custom.css"],
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: true,
      },
      sidebar: [
        "",
        "config",
        "providers",
        "network",
        "enterprise",
        "troubleshooting",
        {
          label: "Windows",
          translations: {
            en: "Windows",
            "ja-JP": "Windows",
            "zh-CN": "Windows",
          },
          link: "windows-wsl",
        },
        {
          label: "Usage",
          translations: {
            en: "Usage",
            "ja-JP": "使い方",
            "zh-CN": "使用",
          },
          items: ["go", "tui", "cli", "web", "ide", "zen", "share", "github", "gitlab"],
        },

        {
          label: "Configure",
          translations: {
            en: "Configure",
            "ja-JP": "設定",
            "zh-CN": "配置",
          },
          items: [
            "tools",
            "rules",
            "agents",
            "models",
            "themes",
            "keybinds",
            "commands",
            "formatters",
            "permissions",
            "lsp",
            "mcp-servers",
            "acp",
            "skills",
            "custom-tools",
          ],
        },

        {
          label: "Develop",
          translations: {
            en: "Develop",
            "ja-JP": "開発",
            "zh-CN": "开发",
          },
          items: ["sdk", "server", "plugins", "ecosystem"],
        },
      ],
      components: {
        Hero: "./src/components/Hero.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      plugins: [
        theme({
          headerLinks: config.headerLinks,
        }),
      ],
    }),
  ],
})

function configSchema() {
  return {
    name: "configSchema",
    hooks: {
      "astro:build:done": async () => {
        console.log("generating config schema")
        spawnSync("../opencode/script/schema.ts", ["./dist/config.json", "./dist/tui.json"])
      },
    },
  }
}
