// ESLint 配置（扁平配置格式，ESLint 9+）
//
// 为什么要有这个文件：2026-10-22 一台别的电脑上的外部评审抓到两个低级错——
// `src/main.mjs` 的 finishTurn 里用了不在作用域的 `msgs`（让「引用回复」整条链路失效），
// 以及 `cfg.owner.userIds[0] || cfg.owner.userIds[0]` 这种 `a || a`。
// 这两条恰好是 eslint:recommended 里 no-undef 和 no-constant-binary-expression 能直接抓到的。
//
// 用法：npm run lint
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // 用户自己的数据、打包产物、临时脚本都不看
    ignores: [
      'node_modules/**',
      'data/**',
      'tmp/**',
      'backups/**',
      'notebook/**',
      'SD-Picture/**',
      'stickers/**',
      'dsh-image-gen/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
        // 浏览器侧（plugin/client.js 在 DSH 的 Web 页面里跑）
        ...globals.browser,
        // 宿主注入
        __ModuleLoader__: 'readonly',
      },
    },
    rules: {
      // 下面这几条在「能跑但不够干净」的范围里，不当错误挡住 CI：
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // 真错误，保持默认（等于 error）
      'no-undef': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
    },
  },
];
