// 261011 Red B1.1：让 bun 测试链按 Solid 语义编译 .tsx。
//
// 背景（有探针实证）：app 的 tsconfig 是 `jsx: "preserve"`（vite-plugin-solid 的
// 约定），bun 不支持 preserve，fallback 成 React.createElement（ReferenceError:
// React is not defined）；改用 `jsx: "react-jsx"` + jsxImportSource solid-js 时，
// solid 的 jsx-runtime 是 SSR 实现——客户端 render 输出为空（PROBE3 JSX: ""）。
//
// 分工与 vite 一致：babel 只做 JSX → solid 的 h() 转换；TS 类型剥离交还 bun
// （loader: "ts"）。不要在这里加 @babel/preset-typescript——曾用
// `onlyRemoveTypeImports: true` 搭配它，会把 `import { SomeType }` 形式的类型导入
// 残留成运行时导入，引发 "Export named 'X' not found"（context 套件 10 fail /
// 8 error 的根因，已反证）。类型消除必须留给 bun 自己的 TS 转译。
import { plugin } from "bun"
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"

plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const result = await transformAsync(source, {
        filename: args.path,
        presets: [[solid, {}]],
        parserOpts: { plugins: ["typescript", "jsx"] },
        babelrc: false,
        configFile: false,
      })
      return { contents: result?.code ?? source, loader: "ts" }
    })
  },
})
