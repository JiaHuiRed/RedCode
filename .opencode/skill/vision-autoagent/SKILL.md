# 视觉自动分析 (Vision AutoAgent)

当用户发送图片时，当前模型（DeepSeek）不支持多模态，会报错。此时需自动调用 vision MCP 工具分析图片并回复用户。

## 触发条件

收到类似错误时：
- "this model does not support image input"
- "Cannot read \"<filename>\""
- 任何提及用户发送了图片但模型无法处理的报错

## 执行流程

1. **判断报错类型**：如果报错提到"不支持图片输入"或"文件不可读"，确认用户确实发过图

2. **按文件名搜索（兜底）**：从报错信息中提取文件名（如 `Li.jpg`），依次搜索：
   - `%USERPROFILE%\Pictures\`
   - `%TEMP%\`
   - `%LOCALAPPDATA%\redcode\`
   - `%USERPROFILE%\.local\share\redcode\`

3. **按时间搜索（主要手段）**：
   - 报错中的文件名通常是系统占位名（如 `image.png`），不是磁盘上的真实文件名
   - 所以不管文件名搜没搜到，都在上述目录中按修改时间倒序搜索最近 10 分钟内创建的图片（`*.png`, `*.jpg`, `*.jpeg`, `*.webp`）
   - 取最新的那个作为分析对象

4. **调用 vision MCP**：使用 `vision_analyze_image` 工具，参数：
   - `image`：找到的完整文件路径
   - `prompt`：根据上下文自动生成分析提示词

5. **回复用户**：直接展示分析结果，无需额外提示

## 注意事项

- 整个流程在后台静默进行，用户只看到最终分析结果
- 无需询问用户是否要使用 vision 工具
- 如果按时间搜索也找不到图片，请用户重发
