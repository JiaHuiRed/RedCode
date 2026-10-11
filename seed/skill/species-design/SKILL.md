---
name: species-design
description: RedMon 精灵设计——标准格式、插入规则、字段说明、威武程度分级、属性命名表，免去反复读 design_guide。用户说「设计精灵」「加个精灵」时触发。
---

# Species Design — RedMon 精灵设计规范

## 触发方式

用户说以下内容时触发：
- "设计精灵"
- "新精灵"
- "species design"
- "加个精灵"
- "做个精灵"
- "设计个 xxx"

## 核心原则

**设计阶段只输出三样东西**：名字、外形提示词（完整生图 prompt）、种族值。**入库阶段**再补齐 `species.json` 的全部字段（见「字段说明」），两个阶段别混。

**不读 design_guide**——本 skill 已浓缩 design_guide 的核心规则。

---

## 数据文件

**路径**：`F:\Pokemon\RedMon\data\species.json`

**结构**：一个大的 JSON 对象，**key 是精灵中文名**（不是数字 id）；数字 `id` 是 value 里的字段。

```json
{
  "炎喵": {
    "id": 4,
    "name": "炎喵",
    "type1": "火",
    ...
  }
}
```

**id 规则**：数字、唯一、从 1 起连续；新精灵 `id` = 当前最大 id + 1。
**当前状态每次实测，不要照抄数字**：
```bash
python -c "import json,io; d=json.load(io.open(r'F:\Pokemon\RedMon\data\species.json',encoding='utf-8')); print('count', len(d), 'max_id', max(v['id'] for v in d.values()))"
```
（截至 2026-10-11：446 只，max_id=446）

---

## 插入规则

**追加为主**：JSON 对象无序，新条目直接追加到文件末尾（`"新名字": {...}` + 逗号）即可，无需按 id 位置插入。

**改完必做键完整性校验**（文件 400KB+，手工/脚本改容易漏字段或重键）：
```bash
python -c "import json,io; d=json.load(io.open(r'F:\Pokemon\RedMon\data\species.json',encoding='utf-8')); req={'id','name','type1','type2','base','catch_rate','exp_yield','growth_rate','desc','tier','gender_ratio','height','weight','evolutions','evolves_into','evolve_level','learnset','abilities'}; print('missing:', [(k,sorted(req-set(v))) for k,v in d.items() if req-set(v)][:5])"
```
只判 `json.load` 通过不够——重复键在 json 里静默取最后一个，语义会坏。

---

## 精灵对象格式参考

```json
{
  "id": 93,
  "name": "毒影马",
  "type1": "毒",
  "type2": "地面",
  "base": {
    "hp": 82,
    "atk": 95,
    "def": 70,
    "sp_atk": 60,
    "sp_def": 75,
    "spd": 88
  },
  ...
}
```

**注意**：设计精灵时，你只需要填写 **名字、外形提示词、种族值** 三项，其余字段由用户自行补充。

---

## 字段说明

实际写库字段（以 `species.json` 现有条目为准）：

| 字段 | 类型 | 说明 | 示例 |
|------|------|------|------|
| `id` | number | 唯一数字标识，= 当前最大 id + 1 | 93 |
| `name` | string | 精灵中文名（同时是对象的 key） | "毒影马" |
| `type1` | string | 主属性 | "毒" |
| `type2` | string | 副属性，无则为空字符串 | "地面" |
| `base` | object | 六维 | {hp, atk, def, sp_atk, sp_def, spd} |
| `catch_rate` | number | 捕获率（越低越难抓，常见 24~171） | 60 |
| `exp_yield` | number | 打败获得的经验值 | 150 |
| `growth_rate` | string | 成长曲线 | "早熟"/"正常"/"大器晚成" |
| `desc` | string | 图鉴描述，1-3 句话 | "身怀毒性与大地之力的灵马…" |
| `tier` | string | 品阶，**由 BST 决定**（见下表） | "神" |
| `gender_ratio` | string | 性别比 | "50/50"/"0/100"/"100/0"/"无性别" |
| `height` | string | 身高（米，字符串） | "1.5" |
| `weight` | string | 体重（千克，字符串） | "120.0" |
| `evolutions` | array | 进化路线，无则 [] | [{"into": "影狐", "level": 22}] |
| `evolves_into` | string | 进化目标名，无则 "" | "影狐" |
| `evolve_level` | number | 进化等级，无则 0 | 22 |
| `learnset` | object | 技能表，key 为等级字符串，value 为技能名数组 | {"1": ["撞击"], "5": ["飞踢"]} |
| `abilities` | array | 普通特性名数组（1~2 个） | ["精神力", "恶梦"] |

**`design_origin` / `role` 字段**：只有部分**老条目**还带着（如 id 446 岚翎），**新条目一律不写**。

**特性与技能来源（关键）**：
- 特性定义池：`data/abilities.json`（222 个）。**但只有 `scripts/components/battle_abilities.gd` 里按名字实现的特性才在战斗里生效**——挑特性前先在该文件搜特性名确认（例如「迷人之躯」「幻觉」有 json 定义但没实现，等于无效）。
- 技能池：`data/moves.json`（939 个，key 为技能名）。learnset 只能填这里存在的技能名。
- `gender_ratio` 实际值：`"50/50"` `"0/100"`（全雌）`"100/0"`（全雄）`"无性别"` `"87.5/12.5"` `"80/20"` `"70/30"` `"60/40"`。

---

## 生图 Prompt 后缀（必须追加）

**每次生图只生成一个视角，分两次生成，各 512×512。**

**正面图后缀**（第一次生图用）：
```
Chinese mythology inspired original monster.
Pokemon GBA pixel art style, clean readable design.
Warm saturated color palette. No grey tones.
Dark brown outlines (not pure black).
Light source from upper-left, consistent three-layer shading.
Clear silhouette recognizable at small size.
Natural creature anatomy. No robotic or mechanical parts (unless Steel type).
Transparent background.
Front view facing forward. Centered full body.
512x512.
```

**背面图后缀**（第二次生图用）：
```
Chinese mythology inspired original monster.
Pokemon GBA pixel art style, clean readable design.
Warm saturated color palette. No grey tones.
Dark brown outlines (not pure black).
Light source from upper-left, consistent three-layer shading.
Clear silhouette recognizable at small size.
Natural creature anatomy. No robotic or mechanical parts (unless Steel type).
Transparent background.
Back view, body slightly turned to the right (3/4 back view). Centered full body.
512x512.
```

**规则：**
- 正面图：精灵面朝观众，全幅居中，用于敌方战斗显示
- 背面图：精灵背对观众、微向右转（3/4 背面），全幅居中，用于我方战斗显示
- 不再拼图，不再裁剪

### 重要！后缀操作纪律

1. **后缀逐字复制**，不要意译/精简——凭记忆改写后缀容易漏掉光源方向、描边颜色、构图居中这几句最容易被省略的约束
2. **能垫图就垫图**：如果所用模型支持参考图，优先上传已生成的同属性精灵图作为参考
3. **豆包等国产模型用中文 prompt**：遇到豆包不认识英文罕见词时，改用详细中文描述 + `透明背景。` 标注

### 威武程度按档次分级

"参照中国神话"这句锚定很容易让模型无意识把每只精灵都设计得强大威猛。写具体描述时，按下表选用对应档次的气质词汇：

| 档次 | 气质关键词（写进描述里） | 避免使用 |
|------|------------------------|---------|
| 凡 | 憨态、朴素、小巧、笨拙、谐趣、平平无奇 | 霸气、神威、君临 |
| 灵 | 精悍、敏捷、初具锋芒、略显自信 | 至高无上、神话尺度 |
| 玄 | 强悍、气场初显、身经百战 | （可少量使用玄档以上词汇） |
| 地 | 威猛、霸气、难以撼动 | — |
| 神 | 神威、煞气逼人、半神姿态 | — |
| 天 | 至高无上、神话尺度、君临天下 | — |

### 进化链气质台阶差（重要）

同一进化链中，**只有最终形态才能用"霸气/神威/君临"级别的顶级词汇**。二段（中间形态）必须用低一档的词汇描述，哪怕它自身档次（灵/玄）允许用更强词——目的是让三段在气势上有明显台阶差，而不是看起来一样强。

---

## BST 档次对应表（实测自 species.json）

**品阶由种族值总和（BST）决定**，档次由低到高：**凡 < 灵 < 玄 < 神 < 地 < 天**。

| 档次 | BST 范围 |
|------|---------|
| 凡 | 180~299 |
| 灵 | 300~409 |
| 玄 | 410~529 |
| 神 | 530~630 |
| 地 | 640~710 |
| 天 | 720~780 |

注意：**「神」低于「地」**（不是常见的 地<神 顺序），别再记反。BST 落在哪个区间就填哪个 tier。

---

## 属性命名字根表

设计精灵/技能名称时，优先使用对应属性的专属字根，让玩家一眼识别属性归属。

| 属性 | 推荐字根 | 已有命名示例 |
|------|----------|-------------|
| 火 | 炎、焰、曜、赤、丹、焚、烈 | 炎喵、烈火猫、焚焰狮、炎凰、焱纹虎 |
| 水 | 渊、泽、澜、汐、溟、蛟 | 苍渊、蓝蛇、江蛟、覆海龙、玄溟 |
| 木 | 竹、森、藤、青、芽、檀 | 小竹熊、古檀灵、灵芽儿、草御剑 |
| 雷 | 霆、雷、电、震、啸 | 霆啸、粉粉丘 |
| 冰 | 霜、冰、凌、寒、冻 | 幼冰犬、霜铠犬、铠霜战狼 |
| 格 | 武、拳、斗、功、道 | 武道熊、功夫熊师 |
| 毒 | 毒、瘴、蛊、瘟、沼 | 瘴龙、毒沼王 |
| 土 | 岩、土、泥、砂、石 | 岩灵、岩傩神、泥蛙 |
| 风 | 翼、羽、风、翔、云 | 小雉鸡、坤鸡、大蝶 |
| 灵 | 灵、念、幻、梦、心 | 元英、智敏、古檀灵 |
| 虫 | 蛹、蚕、蛛、螳、蝶 | 绿肥虫、蛹甲、绿螳螂、天蚕铠 |
| 岩 | 岩、石、砾、磐 | 岩石巨人、小石蟹 |
| 鬼 | 幽、魂、魅、魇、傩 | 岩傩神、石面具 |
| 龙 | 龙、蛟、渊、鳞 | 苍渊、覆海龙、瘴龙 |
| 暗 | 冥、暗、影、夜、墨 | 影狐、幽狐 |
| 钢 | 铜、铁、铸、钧、铠、钺 | 铎狐、铠灵、铠霜战狼、钺霄 |
| 仙 | 仙、灵、华、瑞、祥 | 太一、绵绵羊、绒绒云 |
| 空 | （普通属性，不限制） | 吉他小猪、荒牛 |

## 双属性命名规则

双属性精灵命名时，优先用**主属性字根 + 副属性字根**拼接；若找不到自然组合，改用单一核心意象词涵盖两属性。

| 类型 | 规则 | 示例 |
|------|------|------|
| 主+副拼接 | 主属性字根开头，副属性字根结尾 | 岩傩神（岩主/鬼副）、铠霜战狼（钢主/冰副） |
| 核心意象 | 两属性融合为一个整体概念 | 苍渊（水/龙）、毒沼王（毒/水）、太一（仙/空） |

---

## 进化设计原则

### 三段进化（30/70 法则）

每次进化**保留 30% 核心特征**（让玩家认出血统），**变化 70%**（体现成长）。

| 保留的（30%） | 变化的（70%） |
|-------------|-------------|
| 核心配色（主色调不变） | 体型增大、比例变化 |
| 标志性部位（如尾巴形状、额纹） | 新增装饰/武器/铠甲 |
| 眼睛风格 | 姿态从四足→双足，或温顺→威猛 |

### 分支进化

分支进化的两个终态应该：
- 共享基础形态的核心特征
- 在属性/定位上明确分化（如小石蟹 → 铁甲战蟹(水/钢) / 幽毒海蟹(水/毒)）

---

## 提示词格式要求

**优先用英文**，不要中英混写。如果豆包等国产模型不认识英文罕见词，改用**中文详细描述** + `透明背景。` 标注。每个精灵需要**两套提示词**（分两次生成）：

**正面图提示词格式：**
1. **主体描述**：精灵的外形、姿态、特征（2-3句话）
2. **颜色/材质**：主色调、斑纹、发光部位等
3. **正面图后缀**：标准化的 suffix（见上节）

**背面图提示词格式：**
1. 同上的主体描述（可略微调整以展现背面特征）
2. **背面图后缀**：标准化的 suffix（见上节）

---

## 工作流程

### 1. 读取现有条目

读 `F:\Pokemon\RedMon\data\species.json` 中任意一个完整条目，作为格式参考。

### 2. 确认需求

向用户确认：
- 精灵名字
- 外形关键词/灵感
- 属性组合
- 大致定位（品阶/种族值总和范围）

### 3. 输出三样东西

只输出：

```markdown
**名字**：xxx
**外形提示词**：xxx（用于生成精灵图，尽量详细描述外观、姿态、颜色、特征）
**种族值**：
- hp: N
- atk: N
- def: N
- sp_atk: N
- sp_def: N
- spd: N
- 合计：N
```

其余字段由用户自行填写。**必须一并给出**：
- `desc`：图鉴描述，1-3 句话
- `tier`：品阶，按 BST 查上表自动确定（注意 凡 < 灵 < 玄 < 神 < 地 < 天）

（`design_origin`/`role` 实际库里不存在，不要写）

### 4. 插入位置

告知用户插入到 `species.json` 的 id（当前最大 id + 1，直接追加到文件末尾）。

---

## 示例

### 设计一个毒/地面马形精灵

用户："设计个 id=93 的毒影马，外形像马但有蝎尾， Poison/Ground 属性"

**名字**：毒影马

**正面图提示词**：
A large dark warhorse, body covered in deep purple spotted poison carapace, hooves stepping on rocky hard keratin. Fangs with poison on both sides of its horse head, emerald bone spines along its back, tail curved like a scorpion's stinger dripping green venom. Mane is a wispy dark green poison mist, eyes glowing with dark red light. Dark purple + rock brown + emerald green color scheme, powerful and dangerous.

Chinese mythology inspired original monster.
Pokemon GBA pixel art style, clean readable design.
Warm saturated color palette. No grey tones.
Dark brown outlines (not pure black).
Light source from upper-left, consistent three-layer shading.
Clear silhouette recognizable at small size.
Natural creature anatomy. No robotic or mechanical parts (unless Steel type).
Transparent background.
Front view facing forward. Centered full body.
512x512.

**背面图提示词**：
Same dark warhorse, shown from behind with body slightly turned to the right, revealing the scorpion-like tail and the spiked back ridge. Dark purple carapace, emerald bone spines, poison mist mane visible from rear angle.

Chinese mythology inspired original monster.
Pokemon GBA pixel art style, clean readable design.
Warm saturated color palette. No grey tones.
Dark brown outlines (not pure black).
Light source from upper-left, consistent three-layer shading.
Clear silhouette recognizable at small size.
Natural creature anatomy. No robotic or mechanical parts (unless Steel type).
Transparent background.
Back view, body slightly turned to the right (3/4 back view). Centered full body.
512x512.

**种族值**：
- hp: 65
- atk: 85
- def: 60
- sp_atk: 45
- sp_def: 55
- spd: 90
- 合计：400

 **插入位置**：id=401（当前最大 id=400，直接追加到文件末尾）

---

## 注意事项

1. **id 不能重复**：实测当前最大 id + 1，不要硬编码
2. **name 不能重复**：精灵名必须唯一，且它就是对象 key
3. **种族值平衡**：总和落在对应品阶区间即可（见 BST 表）
4. **外形提示词**：尽量详细描述外观、姿态、颜色、特征，用于生成精灵图
5. **威武程度分级**：凡/灵档写"憨态、朴素"，地/天档才写"君临天下"，不要每只都像 boss
6. **进化链台阶差**：二段必须用低一档气质词汇，最终形态才能用顶级词
7. **改库后必校验**：跑键完整性遍历（见「插入规则」），只判 `json.load` 通过不够
8. **特性先查实现**：只挑 `battle_abilities.gd` 里已实现的特性名

---

## 输出格式

每次设计精灵，只输出：

```markdown
**名字**：<中文名>

**正面图提示词**：
<英文描述，2-3句话>

Chinese mythology inspired original monster.
Pokemon GBA pixel art style, clean readable design.
Warm saturated color palette. No grey tones.
Dark brown outlines (not pure black).
Light source from upper-left, consistent three-layer shading.
Clear silhouette recognizable at small size.
Natural creature anatomy. No robotic or mechanical parts (unless Steel type).
Transparent background.
Front view facing forward. Centered full body.
512x512.

**背面图提示词**：
<同上主体描述，微调展现背面特征>

Chinese mythology inspired original monster.
Pokemon GBA pixel art style, clean readable design.
Warm saturated color palette. No grey tones.
Dark brown outlines (not pure black).
Light source from upper-left, consistent three-layer shading.
Clear silhouette recognizable at small size.
Natural creature anatomy. No robotic or mechanical parts (unless Steel type).
Transparent background.
Back view, body slightly turned to the right (3/4 back view). Centered full body.
512x512.

**种族值**：
- hp: N
- atk: N
- def: N
- sp_atk: N
- sp_def: N
- spd: N
- 合计：N

**插入位置**：id=<当前最大id+1>（直接追加到文件末尾）

**别忘了补充**：`desc`（图鉴描述）、`tier`（按 BST 定）

**威武程度注意**：按档次选气质词汇，凡/灵/玄档不要用"霸气/神威"类词
```
