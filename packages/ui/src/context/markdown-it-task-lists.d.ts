// 260803 Red markdown-it-task-lists 无官方 @types（npm 404），此文件为手写声明。
// marked.tsx 顶部用 /// <reference> 拉入，确保 app/desktop/enterprise 编译 ui 源码时一并加载。
declare module "markdown-it-task-lists" {
  const taskLists: (md: unknown, options?: { enabled?: boolean; label?: boolean }) => void
  export default taskLists
}
