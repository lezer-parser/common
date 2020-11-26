import typescript from "rollup-plugin-typescript2"
import {nodeResolve} from "@rollup/plugin-node-resolve"
import commonJS from "@rollup/plugin-commonjs"

export default {
  input: "./src/tree.ts",
  output: [{
    format: "cjs",
    file: "./dist/tree.cjs",
    sourcemap: true,
    externalLiveBindings: false
  }, {
    format: "es",
    file: "./dist/tree.es.js",
    sourcemap: true,
    externalLiveBindings: false
  }],
  plugins: [
    nodeResolve(),
    commonJS(),
    typescript({
      check: false,
      tsconfigOverride: {
        compilerOptions: {
          lib: ["es5", "es6"],
          sourceMap: true,
          target: "es6",
          strict: false,
          declaration: true
        }
      },
      include: ["src/*.ts"]
    })
  ]
}
