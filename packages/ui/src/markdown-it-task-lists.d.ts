// 260802 Red: markdown-it-task-lists 无官方类型声明，此处补充
declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it"
  type TaskListOptions = {
    enabled?: boolean
    label?: boolean
    labelAfter?: boolean
  }
  declare function taskLists(md: MarkdownIt, options?: TaskListOptions): void
  export default taskLists
}
