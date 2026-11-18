# RedSpace：通往星海的入口

状态：implemented

## 决策

Space 指宇宙与探索。朱红色的开放星门与四角星光构成产品标识，Chat 与 Code 共用品牌。原有朱印继续作为个人落款，与新标识共存；Soul 与看板娘也各自保留身份。

- GUI Mark 与字标共享无 mask、无 ID 的星门 SVG 几何；Seal 保留原朱印。字标为 RedSpace，使用系统字体栈。
- TUI 采用 REDSPACE 像素字，紧凑版 47×5、大版 63×7；沿用现有扫光，不增加动画与计时器。终端首页与页脚保留原朱印，避免改变行高。
- Web 页签、PWA 和桌面三渠道的顶层 PNG / 多帧 ICO / ICNS 使用新标识。旧资源保留兼容引用；未用于当前 Electron 构建的移动端目录不迁移。
- 启动看板娘仍保留，alt 改为 RedSpace。不修改配置目录、包名、命令、用户数据或 Soul。

## 复现

`node script/brand/build-redspace.mjs` 从 SVG 主文件生成发布图标，使用已有 sharp 依赖，不增加运行时依赖。桌面打包仍由 copy-icons.ts 按渠道复制。Web 使用新文件名避开旧 favicon 缓存。

## 取舍

保留红色识别，新产品图标表达宇宙空间；>_ 朱印作为原有落款保留。小尺寸不放人物、文字或复杂纹理。矢量绘制无网络请求，纯静态，无人格或模型提示词变更。

## 验证

UI、app、redspace 类型检查通过；原朱印 3 项测试与快照通过。矢量及 16/24/32/48px 缩略图已目视检查，预览见 [品牌预览](../../../assets/redspace-identity.png)。当前环境未运行 Electron 安装包；实际打包后的 OS 图标仍需安装后确认。

## 2026-11-18 GUI 品牌与桌面应用图标分工

- 新建会话页的 `WordmarkV2` 改为 REDSPACE，保留原有 RED 渐变、SPACE 空心描边与逐字母入场；字距及字号适配八字母的宽度。
- Windows GUI 的多帧 `icon.ico` 与 32/64/128/256 像素 PNG 恢复为 2026-11-17 品牌迁移之前的「赤」原始资源（dev/beta/prod 三渠道），不重新生成角色图。
- `script/brand/build-redspace.mjs` 仅生成 Web 品牌资源，不再覆盖桌面图标。桌面图标交由 `packages/desktop/scripts/build-icons.ts` 独立维护。
- 本次不改 TUI 启动字标、macOS 图标或应用名称。Windows 实际安装包图标需要在本地重编后确认；Windows 图标缓存可能需要刷新。
