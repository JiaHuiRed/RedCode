---
description: 打开或查看手机（局域网）远程访问入口
---

哥哥想用手机连过来。当前 4097 端口状态：

!`powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 4097 -State Listen -ErrorAction SilentlyContinue) { 'LISTENING' } else { 'NOT LISTENING' }"`

按状态处理，不要修改任何文件、不要打开浏览器：

- **已在监听**：不要再启动一个新的。
- **没在监听**：用 shell 工具以隐藏窗口后台启动 `.\script\redcode-lan.bat`（例如 `Start-Process -FilePath ".\script\redcode-lan.bat" -WindowStyle Hidden`），等 2 秒后重新确认端口已在听。

然后输出三行给哥哥，不要多余解释：

1. `手机打开：http://<LAN-IP>:4097` —— IP 取 `ipconfig` 里那个真实的地址，跳过 172.* / 169.254.* / 198.18.* / 198.19.*
2. `用户名：redcode`
3. `密码：<REDCODE_SERVER_PASSWORD 的值，未设置就写内置默认值 RedCode0429>`

最后补一句：手机和电脑要连同一个 Wi-Fi。
