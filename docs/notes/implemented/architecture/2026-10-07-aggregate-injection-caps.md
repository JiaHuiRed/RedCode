# 注入项聚合上限:skill 描述与 MCP guides

状态:implemented

## 问题

单条 cap 已存在(skill `MAX_DESCRIPTION_CHARS=1024`、MCP `MAX_INSTRUCTION_CHARS=2000`),但条目数不受控:描述总量与服务器数量都能把每轮注入顶高——"没有上限就是缺陷不是待办"(模型可见四问之④)。固定前缀审计(认知遗留清理)§24 点名:aggregate caps 缺失(skill/MCP 总量上限,稳定排序裁剪+marker)。

## 决策

- **skill**:`MAX_TOTAL_DESCRIPTION_CHARS = 16_384`(描述文本合计,先过单条 cap 再计入)。超预算的条目整条移出 `<available_skills>`,名字收进末尾一行 marker(`<!-- N skill(s) omitted by description budget: ... -->`)——路由不丢,token 受控。排序保持既有 name 字典序。
- **MCP guides**:`MAX_TOTAL_INSTRUCTION_CHARS = 8192`,`MCP.fmtGuides` 在组装时裁剪(server 名字典序),超出的服务器整段移出、名字进 marker;块组装从 `prompt.ts` 下移到 `mcp/index.ts`(与单条 cap 同域,顺带可单测)。
- **常态零变化**:现用量(24 skill 描述合计约 2K chars;唯一 guides 提供者 jcodemunch 931 chars)远低于预算,逐字节不变;仅条目失控时触发。

## 备选与否决理由

- **不做聚合、只保留单条 cap**:否决——20 条满额描述就是 20K chars/轮,单条 cap 拦不住数量。
- **超预算按顺序硬截断而非整条移出**:否决——半截描述误导路由;整条移出+名字 marker 保住可发现性。
- **按连接顺序而非名字排序**:否决——连接顺序会抖动,导致列表行序在会话间漂移、缓存无谓失效。

## 后果

- 模型可见:超限时列表尾部出现一行 marker;常态一个字节都不变。
- 前缀缓存:常态不动;仅触发时从列表段起失效。
- 预算值:skill 16K(16 条满额)、MCP 8K(4 台满额);数值可按实测调,机制与 marker 格式不变。
- 回链:`src/skill/index.ts`(fmt)、`src/mcp/index.ts`(fmtGuides)、`src/session/prompt.ts`(mcpGuideText);测试 `test/skill/skill.test.ts`(aggregate budget)、`test/mcp/guides.test.ts`。
