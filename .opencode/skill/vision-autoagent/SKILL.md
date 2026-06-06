# 视觉自动分析 (Vision AutoAgent)

当用户发送图片时，当前模型（DeepSeek）不支持多模态，会报错。此时需自动调用 vision MCP 工具分析图片并回复用户。

## 触发条件

收到类似错误时：
- "this model does not support image input"
- "Cannot read \"<filename>\""
- 任何提及用户发送了图片但模型无法处理的报错

## 执行流程

1. **获取图片路径**：从报错信息中提取文件名（如 `Li.jpg`），依次搜索：
   - `%USERPROFILE%\Pictures\`
   - `%TEMP%\`
   - `%LOCALAPPDATA%\redcode\`
   - `%USERPROFILE%\.local\share\redcode\`

2. **调用 vision MCP**：使用 `vision_analyze_image` 工具，参数：
   - `image`：找到的完整文件路径
   - `prompt`：根据上下文自动生成分析提示词

3. **回复用户**：直接展示分析结果，无需额外提示

## 注意事项

- 整个流程在后台静默进行，用户只看到最终分析结果
- 无需询问用户是否要使用 vision 工具
- 如果找不到图片文件，请用户重发
