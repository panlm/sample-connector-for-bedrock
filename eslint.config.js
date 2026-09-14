const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const pluginVue = require('eslint-plugin-vue');
const globals = require('globals');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // TypeScript 编译器已负责这两类检查，core 规则在 TS 上会误报（类型引用、重载签名等），按标准做法关闭。
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  // 前端 .vue：eslint-plugin-vue 的 flat/recommended 预设内部自带 vue-eslint-parser。
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['src-frontend/**/*.{js,vue}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // 不设 parser：.vue 由上面 flat/recommended 提供 vue-eslint-parser，.js 用默认 JS parser。
      globals: {
        ...globals.browser,
        // <script setup> 编译宏，避免对其误报 no-undef。
        defineProps: 'readonly',
        defineEmits: 'readonly',
        defineExpose: 'readonly',
        withDefaults: 'readonly',
        defineOptions: 'readonly',
        defineSlots: 'readonly',
        defineModel: 'readonly',
      },
    },
    rules: {
      // 前端纯 JS 无 TS 编译器兜底，保留 no-unused-vars / no-undef —— 这是让规则真跑，不是放宽。
      ...js.configs.recommended.rules,
    },
  },
];
