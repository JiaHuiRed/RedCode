# ? RedCode

<p align="center">
  <img src="packages/app/public/mona-loading.gif" width="80">
</p>

> **����ĸ������� AI ������֡�** �������ڡ�˵���ġ�����ϲ����ģ�ͣ�DeepSeek / MiMo / �������ȣ���
> _A Chinese-native desktop AI coding agent �� standalone GUI, speaks your language, plug in any model._
>
> ���� [opencode](https://github.com/anomalyco/opencode)��sst.dev����ȶ��ο�����

[![TUI](https://img.shields.io/badge/TUI-0.5.7-blue)](CHANGELOG.md)
[![Desktop](https://img.shields.io/badge/Desktop-0.5.9-0078d4)](CHANGELOG.md)
[![ƽ̨](https://img.shields.io/badge/ƽ̨-Windows%2010%2F11-0078d4)](https://github.com/JiaHuiRed/RedCode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6)](https://typescriptlang.org)
[![Bun](https://img.shields.io/badge/Bun-1.3.x-fcf2d0)](https://bun.sh)
[![����֤](https://img.shields.io/badge/����֤-MIT-lightgrey)](LICENSE)

---

## ? ����ʲô��

AI ������֡�������ڡ�ͬһ������

- **TUI** �� �ն������н��棨`packages/opencode`��
- **GUI** �� ���洰�ڳ���Electron + SolidJS��`packages/desktop`��

�����롢д���롢�� bug���������˵���ģ����ɻ

### ��������

�������⣨TypeGraph / jCodeMunch���� ��ģ�ͣ�DeepSeek / OpenAI / Anthropic / Ollama���� �ļ���д�༭ �� �ն�ִ�� �� Web ���� �� ������Զ��� �� �Ӿ����� �� �Ự���� �� Ȩ���ſ� �� ������ѹ�� �� �Զ�������ϵͳ �� Ŀ����� �� �Զ��� AI �˸�

---

## ?? ���ٿ�ʼ

ǰ��Ҫ��[Bun](https://bun.sh) 1.3+

```bash
git clone https://github.com/JiaHuiRed/RedCode.git
cd RedCode
bun install

# ���� TUI
bun dev

# ���������� GUI
cd packages/desktop && bun run dev
```

> ��һ�������Զ����� `~/.redcode/` ������Ĭ��ģ�壬�����ֶ����á�

### ����

> Ҳ��ֱ��˫��һ�� bat��TUI `packages/opencode/build.bat` / GUI `packages/desktop/build-and-package.bat`��

```bash
# TUI ���ļ� exe
cd packages/opencode && bun run build -- --single

# ���� GUI
cd packages/desktop && bun run build && bun run package
```

---

## ?? �û��ֲ�

ȫ������ָ���� **[MANUAL.md](MANUAL.md)**�����ǣ�

1. �״����ã�����ģ�� / AI �˸� / �û����� / �������䣩
2. ����ϵͳ���Զ���־ / ���ڿ� / ����ע�룩
3. MCP ��������9 ��Ԥ���÷���İ�װ�����ã�
4. ������⣨provider / Ȩ�� / ��Ŀ�����ã�
5. ���������б�
6. Skill ����ϵͳ˵��
7. ��˽ģ������ͬ������

---

## ?? ������־

�� [CHANGELOG.md](CHANGELOG.md)��

---

## ?? ��л

- ԭ��Ŀ��[opencode](https://github.com/anomalyco/opencode)��sst.dev��
- ����֤��MIT
