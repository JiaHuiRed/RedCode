# home 配置合并改用 JSONC 语法树编辑

状态:implemented

## 问题

`script/merge-home-config.ts` 负责把仓库模板的新键补进 `~/.redcode/redcode.jsonc`，早先用
手写扫描器定位插入点。它的 `insertEntry` 在「单行对象 + 有尾逗号」分支里用
`while (c < closePos && text[c] !== ",") c++` 找逗号——**不跳 `/* ... */` 块注释**。
对象写成 `{ "a": 1 /* 说明 */ }` 时，新键会被插进注释内部，脚本仍然打印「已合并」，
用户配置要到下次引擎解析才报错，且看不出是谁写的。

同一文件里还有 `stripJsonc`、`skipTrivia`、`findClose`、`skipVal`、`navigateTo`、
`findKeyPos`、`lastEntryInfo` 七段字符位置计算，每段都是同一类缺陷的候选面。

## 决策

改用 `jsonc-parser`（仓库既有依赖，见 `packages/opencode/package.json`）：

- `parseTree` + `getNodeValue` 取代手写 `stripJsonc` + `JSON.parse`；
- `modify` + `applyEdits` 做键插入，注释与排版由库原样保留；
- 写盘前对结果**重新解析**，与合并结果做 `isDeepStrictEqual` 比对，不一致就报错退出、
  一个字节都不写；
- 合并语义（用户键优先、本地层遮蔽）保持原样，抽成可测试的纯函数
  `parseConfig` / `mergeUserWins` / `mergeConfigText`；
- 主逻辑收进 `if (import.meta.main)`，测试导入时不再触发写盘。

首次播种（home 无配置）在**没有本地遮蔽**时仍直接复制模板，保住模板里的说明注释。

## 备选与否决理由

- **只给手写扫描器补跳注释**：否决——同一文件还有六段同形状的位置计算，逐段打补丁
  等于给下一次事故留位置，而且「改完是否等价」没有便宜的验证手段。
- **引入新依赖**：不必——`jsonc-parser` 已在依赖树里，仓库根可解析
  （实测 `bun -e 'import("jsonc-parser")'` 正常）。
- **本地层损坏时中止同步**（参考实现的做法）：否决——本仓既有约定是「本地层语法坏了
  不阻断同步，但必须 warn」，改成直接失败会放大一次手滑的代价。本轮保持 warn + 空遮蔽。

## 后果

- 插入位置由库决定；注释、尾逗号、CRLF 跟随原文件的格式化选项。
- 新增回归测试 `packages/opencode/test/script/merge-home-config.test.ts`（6 条），其中
  `keeps a single-line object with a block comment intact` 直接盯住原缺陷。
- 识别签名：若再次看到「新键出现在注释里」或「配置只有一半」，先查是否有绕过 `modify`
  的手写插入代码被重新加回来。
