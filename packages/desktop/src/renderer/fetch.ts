// 260923 Red 平台 fetch 包装：input 是 Request 且同时传了 init 时，裸 fetch(request)
// 会把 init 整个丢掉（SDK 存在 Request+init 的调用形状，method/headers/body 全部失效）。
// 抽成独立模块是为了能对它补契约测试——index.tsx import 的瞬间就会 render 整个应用，
// 在入口文件里测不了这个包装。
export const platformFetch: typeof fetch = (input, init) =>
  input instanceof Request ? (init ? fetch(new Request(input, init)) : fetch(input)) : fetch(input, init)
